import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { EditSpec, ResultsPanel } from './resultsPanel';
import { StructurePanels } from './structurePanel';
import { DIAGRAM_CONSTS, DiagramPanels } from './diagramPanel';
import { buildEdges, ErTable, layoutEr, toMermaid } from './erLayout';
import { registerCompletion } from './completionProvider';
import { QueryHistory } from './history';
import { SchemaCache } from './schemaCache';
import { analyze as analyzeSql, assessRun, splitStatements } from './sqlGuard';
import { explainSql, isExplain, planToResult } from './explain';
import { statementAt } from './statementAt';
import { ConnectionConfig, DbDriver, QueryResult } from './types';
import { parseSimpleSelect } from './simpleSelect';
import { paramNames, substituteParams } from './queryParams';
import { diffSchemas, takeSnapshot } from './schemaDiff';
import { SavedQueries } from './savedQueries';
import { SavedFolderNode, SavedQueryNode, SavedTreeProvider } from './savedTree';
import {
  ColumnNode,
  ConnectionNode,
  ConnectionsTreeProvider,
  ContainerNode,
  DbNode,
  GroupNode,
  TableNode,
} from './treeProvider';
import { CancelToken, errorMessage, quoteIdent } from './util';
import { openConnectionForm } from './connectionForm';
import {
  defaultSourcePaths,
  guessSource,
  ImportResult,
  parseConnectionsFile,
  planImport,
  serializeConnections,
  SOURCES,
} from './importers';
import { t, isFrench } from './i18n';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';

let manager: ConnectionManager | undefined;

/** Accès réservé aux tests d'intégration (variable DBX_TEST=1) : jamais exposé en usage normal. */
export interface TestApi {
  manager: ConnectionManager;
  tree: ConnectionsTreeProvider;
  history: QueryHistory;
  saved: SavedQueries;
  associate(documentUri: string, connectionId: string): void;
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const mgr = new ConnectionManager(context);
  manager = mgr;
  const tree = new ConnectionsTreeProvider(mgr);
  const saved = new SavedQueries(context.globalState);
  const savedTree = new SavedTreeProvider(saved);
  const results = new ResultsPanel();
  const structures = new StructurePanels();
  const diagrams = new DiagramPanels();
  const history = new QueryHistory(context.globalState);
  const schema = new SchemaCache((id) => mgr.getDriver(id));
  const running = new Set<CancelToken>();

  /** Connexion associée à chaque éditeur SQL (en mémoire, clé = URI du document). */
  const docConnections = new Map<string, string>();

  // --- Barre d'état : connexion utilisée par l'éditeur SQL actif ----------------------
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  status.command = 'dbExplorer.selectConnection';
  const updateStatus = (): void => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      status.hide();
      return;
    }
    const id = docConnections.get(editor.document.uri.toString());
    const cfg = id ? mgr.get(id) : undefined;
    status.text = cfg
      ? `$(${cfg.production ? 'warning' : cfg.readOnly ? 'lock' : 'database'}) ${cfg.name}` +
        (cfg.production ? ' · PROD' : '') +
        (cfg.readOnly ? t(' · lecture seule', ' · read-only') : '')
      : t('$(database) Choisir une connexion SQL', '$(database) Select a SQL connection');
    status.backgroundColor = cfg?.production
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : undefined;
    status.tooltip = t('DB Explorer : connexion utilisée pour exécuter les requêtes de ce fichier', 'DB Explorer: connection used to run the queries of this file');
    status.show();
  };

  // --- Requête en cours : indicateur cliquable pour l'annuler -----------------------------
  const runningItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
  runningItem.command = 'dbExplorer.cancelQuery';
  runningItem.text = t('$(sync~spin) Requête en cours… (cliquer pour annuler)', '$(sync~spin) Query running… (click to cancel)');
  runningItem.tooltip = t('DB Explorer : interrompre la requête côté serveur', 'DB Explorer: interrupt the query on the server');
  let runningTimer: NodeJS.Timeout | undefined;
  const updateRunning = (): void => {
    void vscode.commands.executeCommand('setContext', 'dbExplorer.queryRunning', running.size > 0);
    if (running.size === 0) {
      clearTimeout(runningTimer);
      runningTimer = undefined;
      runningItem.hide();
    } else if (!runningTimer) {
      // Les requêtes brèves n'affichent rien : l'indicateur n'apparaît qu'après une seconde.
      runningTimer = setTimeout(() => runningItem.show(), 1000);
    }
  };

  // --- Helpers -------------------------------------------------------------------------
  const config = () => vscode.workspace.getConfiguration('dbExplorer');

  async function pickConnection(): Promise<ConnectionConfig | undefined> {
    const all = mgr.list();
    if (all.length === 0) {
      const addLabel = t('Ajouter une connexion', 'Add a connection');
      const choice = await vscode.window.showInformationMessage(
        t('Aucune connexion configurée.', 'No connection configured.'),
        addLabel,
      );
      if (choice) {
        addConnection();
      }
      return undefined;
    }
    if (all.length === 1) {
      return all[0];
    }
    const pick = await vscode.window.showQuickPick(
      all.map((c) => ({ label: c.name, description: `${c.host}:${c.port}`, config: c })),
      { placeHolder: t('Choisir une connexion', 'Select a connection') },
    );
    return pick?.config;
  }

  async function connectionForDocument(doc: vscode.TextDocument): Promise<string | undefined> {
    const key = doc.uri.toString();
    const existing = docConnections.get(key);
    if (existing && mgr.get(existing)) {
      return existing;
    }
    const cfg = await pickConnection();
    if (!cfg) {
      return undefined;
    }
    docConnections.set(key, cfg.id);
    updateStatus();
    return cfg.id;
  }

  const badgesOf = (cfg: ConnectionConfig): string[] => [
    ...(cfg.production ? ['PRODUCTION'] : []),
    ...(cfg.readOnly ? [t('LECTURE SEULE', 'READ-ONLY')] : []),
  ];

  /** Paramètres `:nom` : valeurs demandées une à une (la dernière saisie sert de défaut), puis injectées en littéraux. */
  async function bindParams(cfg: ConnectionConfig, sql: string): Promise<string | undefined> {
    if (!config().get<boolean>('promptParameters', true)) {
      return sql;
    }
    const names = paramNames(sql, cfg.type);
    if (names.length === 0) {
      return sql;
    }
    const memory = context.globalState.get<Record<string, string>>('dbExplorer.paramValues', {});
    const values: Record<string, string> = {};
    for (const [k, name] of names.entries()) {
      const v = await vscode.window.showInputBox({
        title: t(`Paramètre :${name} (${k + 1}/${names.length})`, `Parameter :${name} (${k + 1}/${names.length})`),
        prompt: t('Nombre, texte (mis entre apostrophes automatiquement) ou null', 'Number, text (automatically quoted) or null'),
        value: memory[name] ?? '',
        ignoreFocusOut: true,
      });
      if (v === undefined) {
        return undefined;
      }
      values[name] = v;
    }
    await context.globalState.update('dbExplorer.paramValues', Object.fromEntries(Object.entries({ ...memory, ...values }).slice(-100)));
    return substituteParams(sql, cfg.type, values);
  }

  /**
   * `SELECT * FROM table [WHERE …]` : le résultat correspond à des lignes de la table, la grille
   * peut donc être modifiée via la clé primaire. Toute autre requête reste en lecture seule.
   */
  async function editableSource(
    cfg: ConnectionConfig,
    driver: DbDriver,
    sql: string,
  ): Promise<{ spec: EditSpec; readOnly?: boolean } | undefined> {
    try {
      const simple = cfg.readOnly ? undefined : parseSimpleSelect(sql, cfg.type);
      if (!simple) {
        return undefined;
      }
      let container = simple.container;
      if (!container) {
        container =
          cfg.type === 'sqlite'
            ? 'main'
            : cfg.type === 'mysql'
              ? cfg.database || undefined
              : String((await driver.query('SELECT current_schema()')).rows[0]?.[0] ?? '') || undefined;
      }
      if (!container) {
        return undefined;
      }
      const tableColumns = await driver.listColumns(container, simple.table);
      if (tableColumns.length === 0) {
        return undefined;
      }
      return {
        spec: {
          dbType: cfg.type,
          container,
          table: simple.table,
          tableColumns,
          getDriver: () => mgr.getDriver(cfg.id),
          production: cfg.production,
        },
      };
    } catch {
      return undefined;
    }
  }

  /** Exécute une requête libre et affiche le résultat (modifiable pour un SELECT * simple). */
  async function execute(
    connectionId: string,
    sql: string,
    opts: { fallback?: string; transform?: (r: QueryResult) => QueryResult; confirmExtra?: { message: string; detail: string } } = {},
  ): Promise<void> {
    const cfg = mgr.get(connectionId);
    if (!cfg) {
      return;
    }
    const badges = badgesOf(cfg);

    const bound = await bindParams(cfg, sql);
    if (bound === undefined) {
      return;
    }
    sql = bound;

    // Garde-fous : refus en lecture seule, confirmation des requêtes dangereuses / de production.
    const verdict = assessRun(sql, cfg.type, {
      readOnly: cfg.readOnly,
      production: cfg.production,
      confirmDangerous: config().get<boolean>('confirmDangerous', true),
      confirmProduction: config().get<boolean>('confirmOnProduction', true),
    });
    if (verdict.blocked) {
      results.showError(cfg.name, sql, verdict.blocked, badges);
      return;
    }
    const confirm = opts.confirmExtra ?? verdict.confirm;
    if (confirm) {
      const run = t('Exécuter', 'Run');
      const choice = await vscode.window.showWarningMessage(
        confirm.message,
        { modal: true, detail: confirm.detail },
        run,
      );
      if (choice !== run) {
        return;
      }
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: t(`DB Explorer : exécution sur ${cfg.name}…`, `DB Explorer: running on ${cfg.name}…`),
      },
      async () => {
        const token = new CancelToken();
        running.add(token);
        updateRunning();
        const record = (ok: boolean, ms?: number) =>
          void history.add({ sql, connectionId, connectionName: cfg.name, ok, ms });
        try {
          const driver = await mgr.getDriver(connectionId);
          // MySQL n'accepte qu'une instruction par requête : un script est exécuté instruction par
          // instruction, sur une même connexion.
          const parts = splitStatements(sql, cfg.type);
          let result;
          try {
            try {
              result =
                driver.script && parts.length > 1
                  ? await driver.script(parts, token)
                  : await driver.query(sql, undefined, token);
            } catch (err) {
              if (!opts.fallback || token.requested) {
                throw err;
              }
              result = await driver.query(opts.fallback, undefined, token);
            }
            if (opts.transform) {
              result = opts.transform(result);
            }
          } finally {
            // Même en cas d'erreur : un script a pu modifier la structure avant d'échouer.
            if (verdict.statements.some((s) => s.ddl)) {
              schema.invalidate(connectionId);
              tree.refreshConnection(connectionId);
            }
          }
          record(true, result.durationMs);
          let editable;
          if (!opts.transform && result.columns.length > 0 && !result.sets) {
            editable = await editableSource(cfg, driver, sql);
          }
          results.showResult(cfg.name, sql, result, badges, cfg.type, editable);
        } catch (err) {
          record(false);
          results.showError(cfg.name, sql, token.requested ? t('Requête annulée.', 'Query cancelled.') : errorMessage(err), badges);
        } finally {
          running.delete(token);
          updateRunning();
        }
      },
    );
  }

  /** Dossier choisi pour une requête enregistrée : '' = racine, null = annulé. */
  async function pickSavedFolder(): Promise<string | '' | null> {
    const NEW = t('$(new-folder) Nouveau dossier…', '$(new-folder) New folder…');
    const NONE = t('$(circle-slash) Aucun dossier (racine)', '$(circle-slash) No folder (root)');
    const pick = await vscode.window.showQuickPick([NONE, ...saved.folders().map((f) => `$(folder) ${f}`), NEW], {
      placeHolder: t('Dossier', 'Folder'),
    });
    if (!pick) {
      return null;
    }
    if (pick === NONE) {
      return '';
    }
    if (pick === NEW) {
      const name = await vscode.window.showInputBox({ title: t('Nouveau dossier', 'New folder') });
      return name?.trim() ? name.trim() : null;
    }
    return pick.replace(/^\$\(folder\) /, '');
  }

  /** Instruction sous le curseur (ou sélection) : exécution, EXPLAIN, EXPLAIN ANALYZE. */
  async function runCurrent(mode: 'run' | 'explain' | 'analyze'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage(t('Ouvrez un fichier SQL.', 'Open a SQL file.'));
      return;
    }
    const id = await connectionForDocument(editor.document);
    const cfg = id ? mgr.get(id) : undefined;
    if (!id || !cfg) {
      return;
    }
    const doc = editor.document;
    const text = editor.selection.isEmpty
      ? statementAt(doc.getText(), doc.offsetAt(editor.selection.active), cfg.type)?.sql
      : doc.getText(editor.selection);
    const sql = text?.trim();
    if (!sql) {
      vscode.window.showInformationMessage(t('Aucune instruction sous le curseur.', 'No statement under the cursor.'));
      return;
    }
    if (mode === 'run' || isExplain(sql)) {
      await execute(id, sql);
      return;
    }
    if (splitStatements(sql, cfg.type).length !== 1) {
      vscode.window.showInformationMessage(t('EXPLAIN porte sur une seule instruction : placez le curseur dans l\'une d\'elles.', 'EXPLAIN applies to a single statement: place the cursor in one of them.'));
      return;
    }
    const analyze = mode === 'analyze';
    if (analyze && cfg.type === 'sqlite') {
      vscode.window.showInformationMessage(t('SQLite ne mesure pas l\'exécution : plan estimé affiché.', 'SQLite does not measure execution: showing the estimated plan.'));
    }
    const useAnalyze = analyze && cfg.type !== 'sqlite';
    const plan = explainSql(cfg.type, sql, useAnalyze);
    const writes = analyze && analyzeSql(sql, cfg.type).some((x) => x.kind === 'write');
    await execute(id, plan.primary, {
      fallback: plan.fallback,
      transform: (r) => planToResult(cfg.type, r, useAnalyze),
      confirmExtra: useAnalyze && writes
        ? { message: t('EXPLAIN ANALYZE exécute réellement l\'instruction. Continuer ?', 'EXPLAIN ANALYZE actually runs the statement. Continue?'), detail: sql }
        : undefined,
    });
  }

  /** Aperçu paginé d'une table : page, tri et filtre côté serveur ; édition via la clé primaire. */
  async function previewTable(node: TableNode): Promise<void> {
    const cfg = node.connection;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: t(`DB Explorer : lecture de ${node.table.name}…`, `DB Explorer: reading ${node.table.name}…`),
      },
      async () => {
        try {
          const driver = await mgr.getDriver(cfg.id);
          const tableColumns = await driver.listColumns(node.container, node.table.name);
          await results.openTable({
            dbType: cfg.type,
            container: node.container,
            table: node.table.name,
            tableColumns,
            getDriver: () => mgr.getDriver(cfg.id),
            connectionName: cfg.name,
            isView: node.table.isView,
            pageSize: config().get<number>('previewLimit', 200),
            readOnly: cfg.readOnly,
            production: cfg.production,
            badges: badgesOf(cfg),
          });
        } catch (err) {
          results.showError(
            cfg.name,
            t(`Aperçu de ${node.container}.${node.table.name}`, `Preview of ${node.container}.${node.table.name}`),
            errorMessage(err),
            badgesOf(cfg),
          );
        }
      },
    );
  }

  /** Importe des connexions depuis un export de l'extension, ~/.pgpass, ~/.pg_service.conf ou ~/.my.cnf. */
  async function importConnections(): Promise<void> {
    type Source = { label: string; description?: string; path?: string; source?: keyof typeof SOURCES | 'json'; browse?: boolean };
    const found: Source[] = [];
    for (const s of defaultSourcePaths(process.env, os.homedir(), process.platform)) {
      if (fs.existsSync(s.path)) {
        found.push({ label: SOURCES[s.kind].label, description: s.path, path: s.path, source: s.kind });
      }
    }
    const choice = await vscode.window.showQuickPick<Source>(
      [
        ...found,
        { label: t('$(file) Choisir un fichier…', '$(file) Choose a file…'), description: t('export JSON de DB Explorer Lite, .pgpass, .pg_service.conf, .my.cnf', 'DB Explorer Lite JSON export, .pgpass, .pg_service.conf, .my.cnf'), browse: true },
      ],
      { placeHolder: t('Importer des connexions depuis…', 'Import connections from…') },
    );
    if (!choice) {
      return;
    }
    let file = choice.path;
    if (choice.browse) {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, title: t('Importer des connexions', 'Import connections'), openLabel: t('Importer', 'Import') });
      file = picked?.[0]?.fsPath;
    }
    if (!file) {
      return;
    }
    const size = fs.statSync(file).size;
    if (size > 5 * 1024 * 1024) {
      throw new Error(t('Fichier trop volumineux (5 Mo au maximum).', 'File too large (5 MB maximum).'));
    }
    const content = fs.readFileSync(file, 'utf8');
    const kind = choice.source ?? guessSource(file, content);
    if (!kind) {
      throw new Error(t('Type de fichier non reconnu (attendu : export JSON, .pgpass, .pg_service.conf ou .my.cnf).', 'Unrecognized file type (expected: JSON export, .pgpass, .pg_service.conf or .my.cnf).'));
    }
    const parsed: ImportResult = kind === 'json' ? parseConnectionsFile(content) : SOURCES[kind].parse(content);
    const planned = planImport(parsed.items, mgr.list());
    if (planned.length === 0) {
      vscode.window.showWarningMessage(
        t(`Aucune connexion importable dans ${file}.`, `No importable connection in ${file}.`) + (parsed.skipped.length ? ` ${parsed.skipped.slice(0, 3).join(' ; ')}` : ''),
      );
      return;
    }
    const picks = await vscode.window.showQuickPick(
      planned.map((p) => ({ label: p.label, detail: p.detail, picked: !p.duplicate, item: p })),
      { canPickMany: true, placeHolder: t(`${planned.length} connexion(s) trouvée(s) : cochez celles à importer`, `${planned.length} connection(s) found: tick the ones to import`), matchOnDetail: true },
    );
    if (!picks || picks.length === 0) {
      return;
    }
    for (const p of picks) {
      await mgr.save({ id: randomUUID(), ...p.item.config }, p.item.password);
    }
    const withoutPassword = picks.filter((p) => p.item.config.type !== 'sqlite' && !p.item.password).length;
    let msg = t(`${picks.length} connexion(s) importée(s).`, `${picks.length} connection(s) imported.`);
    if (withoutPassword > 0) {
      msg += t(` ${withoutPassword} sans mot de passe : saisissez-le en modifiant la connexion.`, ` ${withoutPassword} without a password: enter it by editing the connection.`);
    }
    if (parsed.skipped.length > 0) {
      msg += t(
        ` ${parsed.skipped.length} entrée(s) ignorée(s) (${parsed.skipped.slice(0, 2).join(' ; ')}${parsed.skipped.length > 2 ? '…' : ''}).`,
        ` ${parsed.skipped.length} entry(ies) skipped (${parsed.skipped.slice(0, 2).join('; ')}${parsed.skipped.length > 2 ? '…' : ''}).`,
      );
    }
    vscode.window.showInformationMessage(msg);
  }

  /** Ouvre le formulaire de connexion (test et enregistrement s'y font). */
  function addConnection(): void {
    openConnectionForm(mgr);
  }

  // --- Commandes -----------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('dbExplorer.addConnection', addConnection),

    vscode.commands.registerCommand('dbExplorer.editConnection', (node?: ConnectionNode) => {
      if (node) {
        openConnectionForm(mgr, node.config);
      }
    }),

    vscode.commands.registerCommand('dbExplorer.removeConnection', async (node?: ConnectionNode) => {
      if (!node) {
        return;
      }
      const remove = t('Supprimer', 'Delete');
      const choice = await vscode.window.showWarningMessage(
        t(`Supprimer la connexion « ${node.config.name} » ?`, `Delete connection “${node.config.name}”?`),
        { modal: true },
        remove,
      );
      if (choice === remove) {
        await mgr.remove(node.config.id);
        updateStatus();
      }
    }),

    vscode.commands.registerCommand('dbExplorer.setGroup', async (node?: ConnectionNode) => {
      if (!node) {
        return;
      }
      const NEW = t('$(add) Nouveau groupe…', '$(add) New group…');
      const NONE = t('$(close) Aucun groupe', '$(close) No group');
      const pick = await vscode.window.showQuickPick(
        [
          ...mgr.groups().map((g) => ({ label: g, description: g === node.config.group ? t('actuel', 'current') : undefined })),
          { label: NEW, alwaysShow: true },
          { label: NONE, alwaysShow: true },
        ],
        { placeHolder: t(`Ranger « ${node.config.name} » dans un groupe`, `Put “${node.config.name}” in a group`) },
      );
      if (!pick) {
        return;
      }
      let group: string | undefined;
      if (pick.label === NEW) {
        group = (await vscode.window.showInputBox({ prompt: t('Nom du nouveau groupe', 'New group name'), validateInput: (v) => (v.trim() ? undefined : t('Nom obligatoire', 'Name required')) }))?.trim();
        if (!group) {
          return;
        }
      } else if (pick.label !== NONE) {
        group = pick.label;
      }
      await mgr.setGroup([node.config.id], group);
    }),

    vscode.commands.registerCommand('dbExplorer.renameGroup', async (node?: GroupNode) => {
      if (!node) {
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: t(`Nouveau nom du groupe « ${node.name} »`, `New name for group “${node.name}”`),
        value: node.name,
        validateInput: (v) => (v.trim() ? undefined : t('Nom obligatoire', 'Name required')),
      });
      if (name && name.trim() !== node.name) {
        await mgr.renameGroup(node.name, name);
      }
    }),

    vscode.commands.registerCommand('dbExplorer.removeGroup', async (node?: GroupNode) => {
      if (!node) {
        return;
      }
      const remove = t('Supprimer le groupe', 'Delete group');
      const choice = await vscode.window.showWarningMessage(
        t(`Supprimer le groupe « ${node.name} » ?`, `Delete group “${node.name}”?`),
        { modal: true, detail: t(`Ses ${node.count} connexion(s) sont conservées, hors de tout groupe.`, `Its ${node.count} connection(s) are kept, outside any group.`) },
        remove,
      );
      if (choice === remove) {
        await mgr.removeGroup(node.name);
      }
    }),

    vscode.commands.registerCommand('dbExplorer.exportConnections', async () => {
      const all = mgr.list();
      if (all.length === 0) {
        vscode.window.showInformationMessage(t('Aucune connexion à exporter.', 'No connections to export.'));
        return;
      }
      const uri = await vscode.window.showSaveDialog({
        filters: { JSON: ['json'] },
        saveLabel: t('Exporter', 'Export'),
        defaultUri: vscode.Uri.file(`${os.homedir()}/connexions-db-explorer.json`),
      });
      if (!uri) {
        return;
      }
      await vscode.workspace.fs.writeFile(uri, Buffer.from(serializeConnections(all), 'utf8'));
      vscode.window.showInformationMessage(
        t(
          `${all.length} connexion(s) exportée(s) dans ${uri.fsPath}. Les mots de passe ne sont jamais exportés.`,
          `${all.length} connection(s) exported to ${uri.fsPath}. Passwords are never exported.`,
        ),
      );
    }),

    vscode.commands.registerCommand('dbExplorer.importConnections', async () => {
      try {
        await importConnections();
      } catch (err) {
        vscode.window.showErrorMessage(t(`Import impossible : ${errorMessage(err)}`, `Import failed: ${errorMessage(err)}`));
      }
    }),

    vscode.commands.registerCommand('dbExplorer.refresh', () => {
      schema.invalidate();
      tree.refresh();
    }),

    vscode.commands.registerCommand('dbExplorer.forgetSshHosts', async () => {
      const forget = t('Oublier', 'Forget');
      const choice = await vscode.window.showWarningMessage(
        t(
          'Oublier toutes les empreintes de serveurs SSH approuvées ? Elles seront redemandées à la prochaine connexion.',
          'Forget all trusted SSH server fingerprints? They will be requested again on the next connection.',
        ),
        { modal: true },
        forget,
      );
      if (choice === forget) {
        await mgr.forgetSshHosts();
      }
    }),

    vscode.commands.registerCommand('dbExplorer.cancelQuery', async () => {
      await Promise.all([...running].map((t) => t.cancel()));
    }),

    vscode.commands.registerCommand('dbExplorer.history', async () => {
      const entries = history.list();
      if (entries.length === 0) {
        vscode.window.showInformationMessage(t("L'historique des requêtes est vide.", 'The query history is empty.'));
        return;
      }
      const pick = await vscode.window.showQuickPick(
        entries.map((e) => {
          const lines = e.sql.split('\n');
          return {
            label: `${e.ok ? '$(check)' : '$(error)'} ${lines[0].slice(0, 100)}${lines.length > 1 ? ' …' : ''}`,
            description: `${e.connectionName} · ${new Date(e.at).toLocaleString(isFrench() ? 'fr-FR' : 'en-GB')}${e.ms !== undefined ? ` · ${e.ms} ms` : ''}`,
            detail: lines.length > 1 ? e.sql.replace(/\s+/g, ' ').slice(0, 200) : undefined,
            entry: e,
          };
        }),
        { placeHolder: t("Rechercher dans l'historique…", 'Search the history…'), matchOnDescription: true, matchOnDetail: true },
      );
      if (!pick) {
        return;
      }
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: pick.entry.sql + '\n' });
      if (mgr.get(pick.entry.connectionId)) {
        docConnections.set(doc.uri.toString(), pick.entry.connectionId);
      }
      await vscode.window.showTextDocument(doc, { preview: false });
      updateStatus();
    }),

    vscode.commands.registerCommand('dbExplorer.clearHistory', async () => {
      const clear = t('Effacer', 'Clear');
      const choice = await vscode.window.showWarningMessage(
        t("Effacer tout l'historique des requêtes ?", 'Clear the entire query history?'),
        { modal: true },
        clear,
      );
      if (choice === clear) {
        await history.clear();
      }
    }),

    vscode.commands.registerCommand('dbExplorer.newQuery', async (node?: DbNode) => {
      let cfg: ConnectionConfig | undefined;
      let initial = '';
      if (node instanceof ConnectionNode) {
        cfg = node.config;
      } else if (node instanceof ContainerNode) {
        cfg = node.connection;
      } else if (node instanceof TableNode) {
        cfg = node.connection;
        const q = (n: string) => quoteIdent(node.connection.type, n);
        initial = `SELECT * FROM ${q(node.container)}.${q(node.table.name)}\nLIMIT 100;\n`;
      } else {
        cfg = await pickConnection();
      }
      if (!cfg) {
        return;
      }
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: initial });
      docConnections.set(doc.uri.toString(), cfg.id);
      await vscode.window.showTextDocument(doc, { preview: false });
      updateStatus();
    }),

    vscode.commands.registerCommand('dbExplorer.runQuery', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage(t('Ouvrez un fichier SQL pour exécuter une requête.', 'Open a SQL file to run a query.'));
        return;
      }
      const text = editor.selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(editor.selection);
      const sql = text.trim();
      if (!sql) {
        vscode.window.showInformationMessage(t('Aucune requête à exécuter.', 'No query to run.'));
        return;
      }
      const id = await connectionForDocument(editor.document);
      if (id) {
        await execute(id, sql);
      }
    }),

    vscode.commands.registerCommand('dbExplorer.saveQuery', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage(t('Ouvrez un fichier SQL.', 'Open a SQL file.'));
        return;
      }
      const docId = docConnections.get(editor.document.uri.toString());
      const dbType = (docId ? mgr.get(docId)?.type : undefined) ?? mgr.list()[0]?.type ?? 'postgres';
      const sql = (
        editor.selection.isEmpty
          ? (statementAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active), dbType)?.sql ?? '')
          : editor.document.getText(editor.selection)
      ).trim();
      if (!sql) {
        vscode.window.showInformationMessage(t('Aucune requête à enregistrer.', 'No query to save.'));
        return;
      }
      const first = sql.split('\n')[0].replace(/\s+/g, ' ').slice(0, 60);
      const name = await vscode.window.showInputBox({ title: t('Enregistrer la requête', 'Save query'), prompt: t('Nom', 'Name'), value: first, ignoreFocusOut: true });
      if (!name?.trim()) {
        return;
      }
      const folder = await pickSavedFolder();
      if (folder === null) {
        return;
      }
      await saved.add({ name, sql, folder: folder || undefined, connectionId: docId });
      vscode.window.showInformationMessage(t(`Requête « ${name.trim()} » enregistrée.`, `Query “${name.trim()}” saved.`));
    }),

    vscode.commands.registerCommand('dbExplorer.openSaved', async (node?: SavedQueryNode) => {
      if (!node) {
        return;
      }
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: node.query.sql + '\n' });
      if (node.query.connectionId && mgr.get(node.query.connectionId)) {
        docConnections.set(doc.uri.toString(), node.query.connectionId);
      }
      await vscode.window.showTextDocument(doc, { preview: false });
      updateStatus();
    }),

    vscode.commands.registerCommand('dbExplorer.runSaved', async (node?: SavedQueryNode) => {
      if (!node) {
        return;
      }
      const cfg =
        (node.query.connectionId ? mgr.get(node.query.connectionId) : undefined) ?? (await pickConnection());
      if (cfg) {
        await execute(cfg.id, node.query.sql);
      }
    }),

    vscode.commands.registerCommand('dbExplorer.renameSaved', async (node?: SavedQueryNode) => {
      if (!node) {
        return;
      }
      const name = await vscode.window.showInputBox({ title: t('Renommer la requête', 'Rename query'), value: node.query.name });
      if (name?.trim()) {
        await saved.update(node.query.id, { name });
      }
    }),

    vscode.commands.registerCommand('dbExplorer.moveSaved', async (node?: SavedQueryNode) => {
      if (!node) {
        return;
      }
      const folder = await pickSavedFolder();
      if (folder !== null) {
        await saved.update(node.query.id, { folder: folder || undefined });
      }
    }),

    vscode.commands.registerCommand('dbExplorer.deleteSaved', async (node?: SavedQueryNode) => {
      if (!node) {
        return;
      }
      const del = t('Supprimer', 'Delete');
      if ((await vscode.window.showWarningMessage(t(`Supprimer la requête « ${node.query.name} » ?`, `Delete query “${node.query.name}”?`), { modal: true }, del)) === del) {
        await saved.remove(node.query.id);
      }
    }),

    vscode.commands.registerCommand('dbExplorer.renameSavedFolder', async (node?: SavedFolderNode) => {
      if (!node) {
        return;
      }
      const name = await vscode.window.showInputBox({ title: t('Renommer le dossier', 'Rename folder'), value: node.name });
      if (name?.trim() && name.trim() !== node.name) {
        await saved.renameFolder(node.name, name);
      }
    }),

    vscode.commands.registerCommand('dbExplorer.deleteSavedFolder', async (node?: SavedFolderNode) => {
      if (!node) {
        return;
      }
      const del = t('Supprimer le dossier', 'Delete folder');
      if (
        (await vscode.window.showWarningMessage(t(`Supprimer le dossier « ${node.name} » ? Ses requêtes sont conservées, à la racine.`, `Delete folder “${node.name}”? Its queries are kept, at the root.`), { modal: true }, del)) === del
      ) {
        await saved.removeFolder(node.name);
      }
    }),

    vscode.commands.registerCommand('dbExplorer.runStatement', () => runCurrent('run')),
    vscode.commands.registerCommand('dbExplorer.explain', () => runCurrent('explain')),
    vscode.commands.registerCommand('dbExplorer.explainAnalyze', () => runCurrent('analyze')),

    vscode.commands.registerCommand('dbExplorer.selectConnection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const cfg = await pickConnection();
      if (cfg) {
        docConnections.set(editor.document.uri.toString(), cfg.id);
        updateStatus();
      }
    }),

    vscode.commands.registerCommand('dbExplorer.previewTable', async (node?: TableNode) => {
      if (node) {
        await previewTable(node);
      }
    }),

    vscode.commands.registerCommand('dbExplorer.showStructure', async (node?: TableNode) => {
      if (!node) {
        return;
      }
      const cfg = node.connection;
      try {
        const structure = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: t(`DB Explorer : structure de ${node.table.name}…`, `DB Explorer: structure of ${node.table.name}…`) },
          async () => (await mgr.getDriver(cfg.id)).describeTable(node.container, node.table.name),
        );
        structures.show(`${cfg.id}/${node.container}/${node.table.name}`, {
          title: cfg.type === 'sqlite' ? node.table.name : `${node.container}.${node.table.name}`,
          connection: cfg.name,
          badges: badgesOf(cfg),
          structure,
        });
      } catch (err) {
        vscode.window.showErrorMessage(t(`Structure de ${node.table.name} : ${errorMessage(err)}`, `Structure of ${node.table.name}: ${errorMessage(err)}`));
      }
    }),

    vscode.commands.registerCommand('dbExplorer.compareSchemas', async (node?: ContainerNode) => {
      if (!node) {
        return;
      }
      const a = node.connection;
      // La cible : une autre base / un autre schéma, de la même connexion ou d'une connexion du même type.
      const sameType = mgr.list().filter((c) => c.type === a.type);
      let target: ConnectionConfig | undefined = a;
      if (sameType.length > 1) {
        const pick = await vscode.window.showQuickPick(
          sameType.map((c) => ({ label: c.name, description: c.id === a.id ? t('(même connexion)', '(same connection)') : '', cfg: c })),
          { placeHolder: t(`Comparer « ${node.container} » avec une base de quelle connexion ?`, `Compare “${node.container}” with a database from which connection?`) },
        );
        target = pick?.cfg;
      }
      if (!target) {
        return;
      }
      let targetContainer: string | undefined;
      try {
        const containers = (await (await mgr.getDriver(target.id)).listContainers()).filter(
          (c) => !(target?.id === a.id && c === node.container),
        );
        if (containers.length === 0) {
          vscode.window.showInformationMessage(t('Aucune autre base ou aucun autre schéma à comparer.', 'No other database or schema to compare.'));
          return;
        }
        targetContainer = (
          await vscode.window.showQuickPick(containers, {
            placeHolder: t(
              `Cible (« ${node.container} » est la référence : le script mettra la cible à son niveau)`,
              `Target (“${node.container}” is the reference: the script will bring the target up to date)`,
            ),
          })
        );
      } catch (err) {
        vscode.window.showErrorMessage(t(`DB Explorer : ${errorMessage(err)}`, `DB Explorer: ${errorMessage(err)}`));
        return;
      }
      if (!targetContainer) {
        return;
      }
      const b = { cfg: target, container: targetContainer };
      try {
        const diff = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t(`DB Explorer : comparaison de ${node.container} et ${b.container}…`, `DB Explorer: comparing ${node.container} and ${b.container}…`) },
          async (progress) => {
            const [da, db] = await Promise.all([mgr.getDriver(a.id), mgr.getDriver(b.cfg.id)]);
            const snapA = await takeSnapshot(da, node.container, (d, n) => progress.report({ message: `${node.container} : ${d} / ${n}` }));
            const snapB = await takeSnapshot(db, b.container, (d, n) => progress.report({ message: `${b.container} : ${d} / ${n}` }));
            return diffSchemas(snapA, snapB);
          },
        );
        const label = { missing: t('manquant dans la cible', 'missing in target'), extra: t('en trop dans la cible', 'extra in target'), changed: t('différent', 'different') } as const;
        const what = { table: t('table', 'table'), view: t('vue', 'view'), column: t('colonne', 'column'), index: 'index', constraint: t('contrainte', 'constraint') } as const;
        results.showResult(
          a.name,
          t(`Comparaison ${node.container} (référence) → ${b.container} (cible)`, `Comparison ${node.container} (reference) → ${b.container} (target)`),
          {
            columns: [t('Table', 'Table'), t('Objet', 'Object'), t('Nom', 'Name'), t('Écart', 'Difference'), t('Détail', 'Detail')],
            rows: diff.items.map((i) => [i.table, what[i.object], i.name, label[i.change], i.detail]),
            rowCount: diff.items.length,
            truncated: false,
            durationMs: 0,
          },
          badgesOf(a),
          a.type,
        );
        const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: diff.script });
        docConnections.set(doc.uri.toString(), b.cfg.id);
        await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        updateStatus();
        if (diff.items.length === 0) {
          vscode.window.showInformationMessage(t('Aucune différence de structure.', 'No structural differences.'));
        }
      } catch (err) {
        vscode.window.showErrorMessage(t(`Comparaison impossible : ${errorMessage(err)}`, `Comparison failed: ${errorMessage(err)}`));
      }
    }),

    vscode.commands.registerCommand('dbExplorer.showDiagram', async (node?: ContainerNode) => {
      if (!node) {
        return;
      }
      const cfg = node.connection;
      const MAX_TABLES = 150;
      try {
        const built = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t(`DB Explorer : diagramme de ${node.container}…`, `DB Explorer: diagram of ${node.container}…`) },
          async (progress) => {
            const driver = await mgr.getDriver(cfg.id);
            const all = (await driver.listTables(node.container)).filter((t) => !t.isView);
            const names = all.map((t) => t.name).sort((a, b) => a.localeCompare(b));
            const kept = names.slice(0, MAX_TABLES);
            const keptSet = new Set(kept);
            const tables: ErTable[] = [];
            let external = 0;
            for (let i = 0; i < kept.length; i += 6) {
              progress.report({ message: `${Math.min(i + 6, kept.length)} / ${kept.length} tables` });
              const chunk = await Promise.all(
                kept.slice(i, i + 6).map(async (name) => ({ name, cols: await driver.listColumns(node.container, name) })),
              );
              for (const { name, cols } of chunk) {
                tables.push({
                  name,
                  columns: cols.map((c) => {
                    const ref = c.references;
                    const inside = ref && ref.container === node.container && keptSet.has(ref.table);
                    if (ref && !inside) {
                      external++;
                    }
                    return {
                      name: c.name,
                      type: c.type,
                      pk: c.primaryKey,
                      fk: inside ? { table: ref.table, column: ref.column } : undefined,
                      external: ref && !inside ? `${ref.container}.${ref.table}` : undefined,
                    };
                  }),
                });
              }
            }
            return { tables, external, skipped: names.length - kept.length };
          },
        );
        const edges = buildEdges(built.tables);
        diagrams.show(
          `${cfg.id}/${node.container}`,
          {
            title: cfg.type === 'sqlite' ? cfg.name : node.container,
            connection: cfg.name,
            badges: badgesOf(cfg),
            tables: built.tables,
            edges,
            layouts: {
              full: layoutEr(built.tables, edges, { keysOnly: false }),
              keys: layoutEr(built.tables, edges, { keysOnly: true }),
            },
            external: built.external,
            skipped: built.skipped,
            consts: DIAGRAM_CONSTS,
          },
          toMermaid(built.tables, edges),
          (table) =>
            void previewTable(new TableNode(cfg, node.container, { name: table, isView: false })),
        );
      } catch (err) {
        vscode.window.showErrorMessage(t(`Diagramme de ${node.container} : ${errorMessage(err)}`, `Diagram of ${node.container}: ${errorMessage(err)}`));
      }
    }),

    vscode.commands.registerCommand('dbExplorer.copyName', async (node?: DbNode) => {
      let name: string | undefined;
      if (node instanceof TableNode) {
        name = node.table.name;
      } else if (node instanceof ColumnNode) {
        name = node.column.name;
      } else if (node instanceof ContainerNode) {
        name = node.container;
      }
      if (name) {
        await vscode.env.clipboard.writeText(name);
      }
    }),
  );

  // --- Vue, événements, nettoyage ------------------------------------------------------
  context.subscriptions.push(
    vscode.window.createTreeView('dbExplorer.connections', {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),
    vscode.window.createTreeView('dbExplorer.saved', { treeDataProvider: savedTree }),
    status,
    runningItem,
    registerCompletion(schema, (doc) => {
      const id = docConnections.get(doc.uri.toString());
      return id ? mgr.get(id) : undefined;
    }),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    mgr.onDidChange(() => {
      schema.invalidate();
      updateStatus();
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => docConnections.delete(doc.uri.toString())),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dbExplorer.showSystemSchemas')) {
        tree.refresh();
      }
    }),
  );

  updateStatus();

  if (process.env.DBX_TEST === '1') {
    return { manager: mgr, tree, history, saved, associate: (uri, id) => void docConnections.set(uri, id) };
  }
  return undefined;
}

export async function deactivate(): Promise<void> {
  await manager?.dispose();
  manager = undefined;
}

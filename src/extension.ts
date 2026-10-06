import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { ResultsPanel } from './resultsPanel';
import { StructurePanels } from './structurePanel';
import { DIAGRAM_CONSTS, DiagramPanels } from './diagramPanel';
import { buildEdges, ErTable, layoutEr, toMermaid } from './erLayout';
import { registerCompletion } from './completionProvider';
import { QueryHistory } from './history';
import { SchemaCache } from './schemaCache';
import { analyze as analyzeSql, assessRun, splitStatements } from './sqlGuard';
import { explainSql, isExplain, planToResult } from './explain';
import { statementAt } from './statementAt';
import { ConnectionConfig, QueryResult } from './types';
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
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';

let manager: ConnectionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const mgr = new ConnectionManager(context);
  manager = mgr;
  const tree = new ConnectionsTreeProvider(mgr);
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
        (cfg.readOnly ? ' · lecture seule' : '')
      : '$(database) Choisir une connexion SQL';
    status.backgroundColor = cfg?.production
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : undefined;
    status.tooltip = 'DB Explorer : connexion utilisée pour exécuter les requêtes de ce fichier';
    status.show();
  };

  // --- Requête en cours : indicateur cliquable pour l'annuler -----------------------------
  const runningItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
  runningItem.command = 'dbExplorer.cancelQuery';
  runningItem.text = '$(sync~spin) Requête en cours… (cliquer pour annuler)';
  runningItem.tooltip = 'DB Explorer : interrompre la requête côté serveur';
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
      const choice = await vscode.window.showInformationMessage(
        'Aucune connexion configurée.',
        'Ajouter une connexion',
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
      { placeHolder: 'Choisir une connexion' },
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
    ...(cfg.readOnly ? ['LECTURE SEULE'] : []),
  ];

  /** Exécute une requête libre et affiche le résultat (lecture seule). */
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
      const run = 'Exécuter';
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
        title: `DB Explorer : exécution sur ${cfg.name}…`,
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
          results.showResult(cfg.name, sql, result, badges, cfg.type);
        } catch (err) {
          record(false);
          results.showError(cfg.name, sql, token.requested ? 'Requête annulée.' : errorMessage(err), badges);
        } finally {
          running.delete(token);
          updateRunning();
        }
      },
    );
  }

  /** Instruction sous le curseur (ou sélection) : exécution, EXPLAIN, EXPLAIN ANALYZE. */
  async function runCurrent(mode: 'run' | 'explain' | 'analyze'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('Ouvrez un fichier SQL.');
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
      vscode.window.showInformationMessage('Aucune instruction sous le curseur.');
      return;
    }
    if (mode === 'run' || isExplain(sql)) {
      await execute(id, sql);
      return;
    }
    if (splitStatements(sql, cfg.type).length !== 1) {
      vscode.window.showInformationMessage('EXPLAIN porte sur une seule instruction : placez le curseur dans l\'une d\'elles.');
      return;
    }
    const analyze = mode === 'analyze';
    if (analyze && cfg.type === 'sqlite') {
      vscode.window.showInformationMessage('SQLite ne mesure pas l\'exécution : plan estimé affiché.');
    }
    const useAnalyze = analyze && cfg.type !== 'sqlite';
    const plan = explainSql(cfg.type, sql, useAnalyze);
    const writes = analyze && analyzeSql(sql, cfg.type).some((x) => x.kind === 'write');
    await execute(id, plan.primary, {
      fallback: plan.fallback,
      transform: (r) => planToResult(cfg.type, r, useAnalyze),
      confirmExtra: useAnalyze && writes
        ? { message: 'EXPLAIN ANALYZE exécute réellement l\'instruction. Continuer ?', detail: sql }
        : undefined,
    });
  }

  /** Aperçu paginé d'une table : page, tri et filtre côté serveur ; édition via la clé primaire. */
  async function previewTable(node: TableNode): Promise<void> {
    const cfg = node.connection;
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `DB Explorer : lecture de ${node.table.name}…`,
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
            `Aperçu de ${node.container}.${node.table.name}`,
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
        { label: '$(file) Choisir un fichier…', description: 'export JSON de DB Explorer Lite, .pgpass, .pg_service.conf, .my.cnf', browse: true },
      ],
      { placeHolder: 'Importer des connexions depuis…' },
    );
    if (!choice) {
      return;
    }
    let file = choice.path;
    if (choice.browse) {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, title: 'Importer des connexions', openLabel: 'Importer' });
      file = picked?.[0]?.fsPath;
    }
    if (!file) {
      return;
    }
    const size = fs.statSync(file).size;
    if (size > 5 * 1024 * 1024) {
      throw new Error('Fichier trop volumineux (5 Mo au maximum).');
    }
    const content = fs.readFileSync(file, 'utf8');
    const kind = choice.source ?? guessSource(file, content);
    if (!kind) {
      throw new Error("Type de fichier non reconnu (attendu : export JSON, .pgpass, .pg_service.conf ou .my.cnf).");
    }
    const parsed: ImportResult = kind === 'json' ? parseConnectionsFile(content) : SOURCES[kind].parse(content);
    const planned = planImport(parsed.items, mgr.list());
    if (planned.length === 0) {
      vscode.window.showWarningMessage(
        `Aucune connexion importable dans ${file}.` + (parsed.skipped.length ? ` ${parsed.skipped.slice(0, 3).join(' ; ')}` : ''),
      );
      return;
    }
    const picks = await vscode.window.showQuickPick(
      planned.map((p) => ({ label: p.label, detail: p.detail, picked: !p.duplicate, item: p })),
      { canPickMany: true, placeHolder: `${planned.length} connexion(s) trouvée(s) : cochez celles à importer`, matchOnDetail: true },
    );
    if (!picks || picks.length === 0) {
      return;
    }
    for (const p of picks) {
      await mgr.save({ id: randomUUID(), ...p.item.config }, p.item.password);
    }
    const withoutPassword = picks.filter((p) => p.item.config.type !== 'sqlite' && !p.item.password).length;
    let msg = `${picks.length} connexion(s) importée(s).`;
    if (withoutPassword > 0) {
      msg += ` ${withoutPassword} sans mot de passe : saisissez-le en modifiant la connexion.`;
    }
    if (parsed.skipped.length > 0) {
      msg += ` ${parsed.skipped.length} entrée(s) ignorée(s) (${parsed.skipped.slice(0, 2).join(' ; ')}${parsed.skipped.length > 2 ? '…' : ''}).`;
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
      const remove = 'Supprimer';
      const choice = await vscode.window.showWarningMessage(
        `Supprimer la connexion « ${node.config.name} » ?`,
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
      const NEW = '$(add) Nouveau groupe…';
      const NONE = '$(close) Aucun groupe';
      const pick = await vscode.window.showQuickPick(
        [
          ...mgr.groups().map((g) => ({ label: g, description: g === node.config.group ? 'actuel' : undefined })),
          { label: NEW, alwaysShow: true },
          { label: NONE, alwaysShow: true },
        ],
        { placeHolder: `Ranger « ${node.config.name} » dans un groupe` },
      );
      if (!pick) {
        return;
      }
      let group: string | undefined;
      if (pick.label === NEW) {
        group = (await vscode.window.showInputBox({ prompt: 'Nom du nouveau groupe', validateInput: (v) => (v.trim() ? undefined : 'Nom obligatoire') }))?.trim();
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
        prompt: `Nouveau nom du groupe « ${node.name} »`,
        value: node.name,
        validateInput: (v) => (v.trim() ? undefined : 'Nom obligatoire'),
      });
      if (name && name.trim() !== node.name) {
        await mgr.renameGroup(node.name, name);
      }
    }),

    vscode.commands.registerCommand('dbExplorer.removeGroup', async (node?: GroupNode) => {
      if (!node) {
        return;
      }
      const remove = 'Supprimer le groupe';
      const choice = await vscode.window.showWarningMessage(
        `Supprimer le groupe « ${node.name} » ?`,
        { modal: true, detail: `Ses ${node.count} connexion(s) sont conservées, hors de tout groupe.` },
        remove,
      );
      if (choice === remove) {
        await mgr.removeGroup(node.name);
      }
    }),

    vscode.commands.registerCommand('dbExplorer.exportConnections', async () => {
      const all = mgr.list();
      if (all.length === 0) {
        vscode.window.showInformationMessage('Aucune connexion à exporter.');
        return;
      }
      const uri = await vscode.window.showSaveDialog({
        filters: { JSON: ['json'] },
        saveLabel: 'Exporter',
        defaultUri: vscode.Uri.file(`${os.homedir()}/connexions-db-explorer.json`),
      });
      if (!uri) {
        return;
      }
      await vscode.workspace.fs.writeFile(uri, Buffer.from(serializeConnections(all), 'utf8'));
      vscode.window.showInformationMessage(
        `${all.length} connexion(s) exportée(s) dans ${uri.fsPath}. Les mots de passe ne sont jamais exportés.`,
      );
    }),

    vscode.commands.registerCommand('dbExplorer.importConnections', async () => {
      try {
        await importConnections();
      } catch (err) {
        vscode.window.showErrorMessage(`Import impossible : ${errorMessage(err)}`);
      }
    }),

    vscode.commands.registerCommand('dbExplorer.refresh', () => {
      schema.invalidate();
      tree.refresh();
    }),

    vscode.commands.registerCommand('dbExplorer.forgetSshHosts', async () => {
      const forget = 'Oublier';
      const choice = await vscode.window.showWarningMessage(
        "Oublier toutes les empreintes de serveurs SSH approuvées ? Elles seront redemandées à la prochaine connexion.",
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
        vscode.window.showInformationMessage("L'historique des requêtes est vide.");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        entries.map((e) => {
          const lines = e.sql.split('\n');
          return {
            label: `${e.ok ? '$(check)' : '$(error)'} ${lines[0].slice(0, 100)}${lines.length > 1 ? ' …' : ''}`,
            description: `${e.connectionName} · ${new Date(e.at).toLocaleString('fr-FR')}${e.ms !== undefined ? ` · ${e.ms} ms` : ''}`,
            detail: lines.length > 1 ? e.sql.replace(/\s+/g, ' ').slice(0, 200) : undefined,
            entry: e,
          };
        }),
        { placeHolder: "Rechercher dans l'historique…", matchOnDescription: true, matchOnDetail: true },
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
      const clear = 'Effacer';
      const choice = await vscode.window.showWarningMessage(
        "Effacer tout l'historique des requêtes ?",
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
        vscode.window.showInformationMessage('Ouvrez un fichier SQL pour exécuter une requête.');
        return;
      }
      const text = editor.selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(editor.selection);
      const sql = text.trim();
      if (!sql) {
        vscode.window.showInformationMessage('Aucune requête à exécuter.');
        return;
      }
      const id = await connectionForDocument(editor.document);
      if (id) {
        await execute(id, sql);
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
          { location: vscode.ProgressLocation.Window, title: `DB Explorer : structure de ${node.table.name}…` },
          async () => (await mgr.getDriver(cfg.id)).describeTable(node.container, node.table.name),
        );
        structures.show(`${cfg.id}/${node.container}/${node.table.name}`, {
          title: cfg.type === 'sqlite' ? node.table.name : `${node.container}.${node.table.name}`,
          connection: cfg.name,
          badges: badgesOf(cfg),
          structure,
        });
      } catch (err) {
        vscode.window.showErrorMessage(`Structure de ${node.table.name} : ${errorMessage(err)}`);
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
          { location: vscode.ProgressLocation.Notification, title: `DB Explorer : diagramme de ${node.container}…` },
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
        vscode.window.showErrorMessage(`Diagramme de ${node.container} : ${errorMessage(err)}`);
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
}

export async function deactivate(): Promise<void> {
  await manager?.dispose();
  manager = undefined;
}

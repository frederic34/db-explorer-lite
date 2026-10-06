import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { ResultsPanel } from './resultsPanel';
import { registerCompletion } from './completionProvider';
import { QueryHistory } from './history';
import { SchemaCache } from './schemaCache';
import { assessRun, splitStatements } from './sqlGuard';
import { ConnectionConfig } from './types';
import {
  ColumnNode,
  ConnectionNode,
  ConnectionsTreeProvider,
  ContainerNode,
  DbNode,
  TableNode,
} from './treeProvider';
import { CancelToken, errorMessage, quoteIdent } from './util';
import { openConnectionForm } from './connectionForm';

let manager: ConnectionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const mgr = new ConnectionManager(context);
  manager = mgr;
  const tree = new ConnectionsTreeProvider(mgr);
  const results = new ResultsPanel();
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
  async function execute(connectionId: string, sql: string): Promise<void> {
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
    if (verdict.confirm) {
      const run = 'Exécuter';
      const choice = await vscode.window.showWarningMessage(
        verdict.confirm.message,
        { modal: true, detail: verdict.confirm.detail },
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
          const result =
            driver.script && parts.length > 1
              ? await driver.script(parts, token)
              : await driver.query(sql, undefined, token);
          record(true, result.durationMs);
          results.showResult(cfg.name, sql, result, badges);
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

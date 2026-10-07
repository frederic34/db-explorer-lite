import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { ColumnInfo, ConnectionConfig, TableInfo } from './types';
import { errorMessage } from './util';
import { t as tr } from './i18n';

/** Dossier de connexions. */
export class GroupNode extends vscode.TreeItem {
  constructor(
    public readonly name: string,
    public readonly count: number,
  ) {
    super(name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'group';
    this.iconPath = new vscode.ThemeIcon('folder');
    this.description = String(count);
  }
}

export class ConnectionNode extends vscode.TreeItem {
  constructor(public readonly config: ConnectionConfig) {
    super(config.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'connection';
    this.iconPath = config.production
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.red'))
      : new vscode.ThemeIcon(config.readOnly ? 'lock' : 'server');
    const flags = [config.production ? 'PROD' : '', config.readOnly ? tr('lecture seule', 'read-only') : '', config.ssh ? 'SSH' : ''].filter(Boolean);
    this.description =
      (config.type === 'sqlite'
        ? `SQLite · ${config.file ?? ''}`
        : `${config.type === 'mysql' ? 'MySQL' : 'PostgreSQL'} · ${config.host}:${config.port}`) +
      (flags.length ? ` · ${flags.join(' · ')}` : '');
    this.tooltip =
      (config.type === 'sqlite'
        ? (config.file ?? '')
        : `${config.user}@${config.host}:${config.port}${config.database ? '/' + config.database : ''}`) +
      (config.production ? tr('\nBase de production : confirmation avant écriture', '\nProduction database: confirmation required before writing') : '') +
      (config.readOnly ? tr('\nConnexion en lecture seule', '\nRead-only connection') : '') +
      (config.ssh ? tr(`\nTunnel SSH : ${config.ssh.user}@${config.ssh.host}:${config.ssh.port}`, `\nSSH tunnel: ${config.ssh.user}@${config.ssh.host}:${config.ssh.port}`) : '');
  }
}

/** Base de données (MySQL) ou schéma (PostgreSQL). */
export class ContainerNode extends vscode.TreeItem {
  constructor(
    public readonly connection: ConnectionConfig,
    public readonly container: string,
  ) {
    super(container, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'container';
    this.iconPath = new vscode.ThemeIcon(connection.type === 'postgres' ? 'symbol-namespace' : 'database');
  }
}

export class TableNode extends vscode.TreeItem {
  constructor(
    public readonly connection: ConnectionConfig,
    public readonly container: string,
    public readonly table: TableInfo,
  ) {
    super(table.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = table.isView ? 'view' : 'table';
    this.iconPath = new vscode.ThemeIcon(table.isView ? 'eye' : 'table');
    this.description = table.isView ? tr('vue', 'view') : undefined;
    if (!table.isView && table.rows !== undefined && vscode.workspace.getConfiguration('dbExplorer').get<boolean>('showRowCounts', true)) {
      const n = table.rows.toLocaleString(tr('fr-FR', 'en-US'));
      this.description = (table.approx ? '~' : '') + n;
      this.tooltip = table.approx
        ? tr(`${table.name} — environ ${n} lignes (estimation du serveur)`, `${table.name} — about ${n} rows (server estimate)`)
        : tr(`${table.name} — ${n} lignes`, `${table.name} — ${n} rows`);
    }
  }
}

export class ColumnNode extends vscode.TreeItem {
  constructor(public readonly column: ColumnInfo) {
    super(column.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'column';
    this.iconPath = new vscode.ThemeIcon(column.primaryKey ? 'key' : 'symbol-field');
    this.description = column.type;
    this.tooltip =
      `${column.name} — ${column.type}` +
      (column.nullable ? '' : ' · NOT NULL') +
      (column.primaryKey ? tr(' · clé primaire', ' · primary key') : '');
  }
}

export type DbNode = GroupNode | ConnectionNode | ContainerNode | TableNode | ColumnNode;

export class ConnectionsTreeProvider implements vscode.TreeDataProvider<DbNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<DbNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Dernier nœud créé pour chaque connexion : permet de ne rafraîchir qu'elle (et ses enfants dépliés). */
  private readonly roots = new Map<string, ConnectionNode>();

  constructor(private readonly manager: ConnectionManager) {
    manager.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  private connectionNode(c: ConnectionConfig): ConnectionNode {
    const node = new ConnectionNode(c);
    this.roots.set(c.id, node);
    return node;
  }

  /** Relit une seule connexion (après un CREATE / ALTER / DROP exécuté dans l'éditeur). */
  refreshConnection(id: string): void {
    this._onDidChangeTreeData.fire(this.roots.get(id));
  }

  getTreeItem(element: DbNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DbNode): Promise<DbNode[]> {
    try {
      if (!element) {
        const all = this.manager.list();
        const groups = [...new Set(all.flatMap((c) => (c.group ? [c.group] : [])))].sort((a, b) => a.localeCompare(b));
        return [
          ...groups.map((g) => new GroupNode(g, all.filter((c) => c.group === g).length)),
          ...all.filter((c) => !c.group).map((c) => this.connectionNode(c)),
        ];
      }
      if (element instanceof GroupNode) {
        return this.manager.list().filter((c) => c.group === element.name).map((c) => this.connectionNode(c));
      }
      if (element instanceof ConnectionNode) {
        const driver = await this.manager.getDriver(element.config.id);
        const containers = await driver.listContainers();
        return containers.map((name) => new ContainerNode(element.config, name));
      }
      if (element instanceof ContainerNode) {
        const driver = await this.manager.getDriver(element.connection.id);
        const tables = await driver.listTables(element.container);
        return tables.map((t) => new TableNode(element.connection, element.container, t));
      }
      if (element instanceof TableNode) {
        const driver = await this.manager.getDriver(element.connection.id);
        const columns = await driver.listColumns(element.container, element.table.name);
        return columns.map((c) => new ColumnNode(c));
      }
    } catch (err) {
      vscode.window.showErrorMessage(tr(`DB Explorer : ${errorMessage(err)}`, `DB Explorer: ${errorMessage(err)}`));
    }
    return [];
  }
}

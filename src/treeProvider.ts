import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { ColumnInfo, ConnectionConfig, TableInfo } from './types';
import { errorMessage } from './util';

export class ConnectionNode extends vscode.TreeItem {
  constructor(public readonly config: ConnectionConfig) {
    super(config.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'connection';
    this.iconPath = config.production
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.red'))
      : new vscode.ThemeIcon(config.readOnly ? 'lock' : 'server');
    const flags = [config.production ? 'PROD' : '', config.readOnly ? 'lecture seule' : ''].filter(Boolean);
    this.description =
      `${config.type === 'mysql' ? 'MySQL' : 'PostgreSQL'} · ${config.host}:${config.port}` +
      (flags.length ? ` · ${flags.join(' · ')}` : '');
    this.tooltip =
      `${config.user}@${config.host}:${config.port}${config.database ? '/' + config.database : ''}` +
      (config.production ? '\nBase de production : confirmation avant écriture' : '') +
      (config.readOnly ? '\nConnexion en lecture seule' : '');
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
    this.iconPath = new vscode.ThemeIcon(connection.type === 'mysql' ? 'database' : 'symbol-namespace');
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
    this.description = table.isView ? 'vue' : undefined;
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
      (column.primaryKey ? ' · clé primaire' : '');
  }
}

export type DbNode = ConnectionNode | ContainerNode | TableNode | ColumnNode;

export class ConnectionsTreeProvider implements vscode.TreeDataProvider<DbNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<DbNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly manager: ConnectionManager) {
    manager.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: DbNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DbNode): Promise<DbNode[]> {
    try {
      if (!element) {
        return this.manager.list().map((c) => new ConnectionNode(c));
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
      vscode.window.showErrorMessage(`DB Explorer : ${errorMessage(err)}`);
    }
    return [];
  }
}

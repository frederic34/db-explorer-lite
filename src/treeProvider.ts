import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { ColumnInfo, ConnectionConfig, DefinitionKind, EventInfo, RoutineInfo, TableInfo } from './types';
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

export type CategoryKind = 'tables' | 'views' | 'functions' | 'procedures' | 'events';

/** Rubrique d'une base / d'un schéma : tables, vues, fonctions, procédures, événements. */
export class CategoryNode extends vscode.TreeItem {
  constructor(
    public readonly connection: ConnectionConfig,
    public readonly container: string,
    public readonly kind: CategoryKind,
    public readonly count: number,
  ) {
    super(
      {
        tables: tr('Tables', 'Tables'),
        views: tr('Vues', 'Views'),
        functions: tr('Fonctions', 'Functions'),
        procedures: tr('Procédures', 'Procedures'),
        events: tr('Événements', 'Events'),
      }[kind],
      // les tables, rubrique la plus courante, sont dépliées d'emblée
      kind === 'tables' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.contextValue = 'category';
    this.description = String(count);
    this.iconPath = new vscode.ThemeIcon(
      { tables: 'table', views: 'eye', functions: 'symbol-function', procedures: 'symbol-method', events: 'clock' }[kind],
    );
  }
}

/** Fonction ou procédure stockée. */
export class RoutineNode extends vscode.TreeItem {
  constructor(
    public readonly connection: ConnectionConfig,
    public readonly container: string,
    public readonly routine: RoutineInfo,
  ) {
    super(routine.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = routine.kind;
    this.iconPath = new vscode.ThemeIcon(routine.kind === 'function' ? 'symbol-function' : 'symbol-method');
    this.description = routine.signature !== undefined ? `(${routine.signature})` : undefined;
    this.tooltip = `${routine.name}(${routine.signature ?? ''})`;
    this.command = { command: 'dbExplorer.showDefinition', title: tr('Afficher la définition', 'Show definition'), arguments: [this] };
  }
  get definitionKind(): DefinitionKind {
    return this.routine.kind;
  }
  get definitionId(): string {
    return this.routine.id;
  }
}

/** Événement planifié. */
export class EventNode extends vscode.TreeItem {
  constructor(
    public readonly connection: ConnectionConfig,
    public readonly container: string,
    public readonly event: EventInfo,
  ) {
    super(event.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'event';
    this.iconPath = new vscode.ThemeIcon('clock');
    this.description = event.status ? event.status.toLowerCase() : undefined;
    this.command = { command: 'dbExplorer.showDefinition', title: tr('Afficher la définition', 'Show definition'), arguments: [this] };
  }
  get definitionKind(): DefinitionKind {
    return 'event';
  }
  get definitionId(): string {
    return this.event.name;
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

export type DbNode = GroupNode | ConnectionNode | ContainerNode | CategoryNode | RoutineNode | EventNode | TableNode | ColumnNode;

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
        const [tables, routines, events] = await Promise.all([
          driver.listTables(element.container),
          // routines et événements : facultatifs (droits, version du serveur) — une erreur ne masque pas les tables
          driver.listRoutines(element.container).catch(() => [] as RoutineInfo[]),
          driver.listEvents(element.container).catch(() => [] as EventInfo[]),
        ]);
        const cats: CategoryNode[] = [];
        const add = (kind: CategoryKind, n: number, always = false) => {
          if (n > 0 || always) {
            cats.push(new CategoryNode(element.connection, element.container, kind, n));
          }
        };
        add('tables', tables.filter((x) => !x.isView).length, true);
        add('views', tables.filter((x) => x.isView).length);
        add('functions', routines.filter((x) => x.kind === 'function').length);
        add('procedures', routines.filter((x) => x.kind === 'procedure').length);
        add('events', events.length);
        return cats;
      }
      if (element instanceof CategoryNode) {
        const driver = await this.manager.getDriver(element.connection.id);
        if (element.kind === 'tables' || element.kind === 'views') {
          const tables = await driver.listTables(element.container);
          return tables
            .filter((x) => x.isView === (element.kind === 'views'))
            .map((x) => new TableNode(element.connection, element.container, x));
        }
        if (element.kind === 'events') {
          return (await driver.listEvents(element.container)).map((e) => new EventNode(element.connection, element.container, e));
        }
        const want = element.kind === 'functions' ? 'function' : 'procedure';
        return (await driver.listRoutines(element.container))
          .filter((r) => r.kind === want)
          .map((r) => new RoutineNode(element.connection, element.container, r));
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

export type DbType = 'mysql' | 'postgres';

export interface ConnectionConfig {
  id: string;
  name: string;
  type: DbType;
  host: string;
  port: number;
  user: string;
  /** MySQL : optionnelle (vide = toutes les bases). PostgreSQL : obligatoire. */
  database?: string;
  ssl?: boolean;
}

export interface TableInfo {
  name: string;
  isView: boolean;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface QueryResult {
  columns: string[];
  /** Cellules déjà converties en texte ; null = NULL SQL. */
  rows: (string | null)[][];
  /** Nombre total de lignes retournées par le serveur. */
  rowCount: number;
  /** Lignes affectées (INSERT / UPDATE / DELETE…). */
  affectedRows?: number;
  /** Commande SQL exécutée (PostgreSQL : CREATE, INSERT…). */
  command?: string;
  /** Vrai si rows a été tronqué à dbExplorer.maxRows. */
  truncated: boolean;
  durationMs: number;
}

export interface DbDriver {
  readonly type: DbType;
  /** Bases (MySQL) ou schémas (PostgreSQL). */
  listContainers(): Promise<string[]>;
  listTables(container: string): Promise<TableInfo[]>;
  listColumns(container: string, table: string): Promise<ColumnInfo[]>;
  query(sql: string): Promise<QueryResult>;
  dispose(): Promise<void>;
}

export interface DriverOptions {
  maxRows: () => number;
  showSystem: () => boolean;
}

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
  /** Valeur par défaut, auto-incrément ou identité : on peut omettre la colonne à l'insertion. */
  hasDefault: boolean;
  /** Valeur calculée par le serveur (colonne générée) : ni insertion ni modification possibles. */
  generated: boolean;
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

export interface WriteStatement {
  sql: string;
  params: unknown[];
  /** Nombre de lignes que l'instruction doit affecter ; sinon toute la transaction est annulée. */
  expect?: number;
}

export interface DbDriver {
  readonly type: DbType;
  /** Bases (MySQL) ou schémas (PostgreSQL). */
  listContainers(): Promise<string[]>;
  listTables(container: string): Promise<TableInfo[]>;
  listColumns(container: string, table: string): Promise<ColumnInfo[]>;
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  /**
   * Exécute les instructions dans une transaction (tout ou rien) et retourne,
   * pour chacune, le nombre de lignes affectées.
   */
  executeBatch(statements: WriteStatement[]): Promise<number[]>;
  /**
   * Insère une ligne. PostgreSQL : l'instruction doit se terminer par RETURNING * et la ligne
   * insérée est renvoyée ; MySQL : l'identifiant auto-généré éventuel est renvoyé.
   */
  insertRow(sql: string, params: unknown[]): Promise<{ row?: (string | null)[]; insertId?: string }>;
  dispose(): Promise<void>;
}

export interface DriverOptions {
  maxRows: () => number;
  showSystem: () => boolean;
}

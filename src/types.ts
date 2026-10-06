import { CancelToken } from './util';

export type DbType = 'mysql' | 'postgres' | 'sqlite';

/** Tunnel SSH : la base est jointe à travers ce serveur (hôte et port de la base vus depuis lui). */
export interface SshConfig {
  host: string;
  port: number;
  user: string;
  authMethod: 'password' | 'key' | 'agent';
  /** Chemin de la clé privée (authMethod = key). */
  keyPath?: string;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  type: DbType;
  host: string;
  port: number;
  user: string;
  /** SQLite : chemin du fichier de base (lecture seule). */
  file?: string;
  /** MySQL : optionnelle (vide = toutes les bases). PostgreSQL : obligatoire. */
  database?: string;
  ssl?: boolean;
  /** Connexion en lecture seule : aucune écriture (grille, éditeur SQL), imposée aussi côté serveur. */
  readOnly?: boolean;
  /** Base de production : badge d'avertissement et confirmation avant toute écriture. */
  production?: boolean;
  ssh?: SshConfig;
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
  /** Clé étrangère sur une seule colonne : colonne référencée (les clés composites ne sont pas suivies). */
  references?: { container: string; table: string; column: string };
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
  /** Nombre d'instructions exécutées quand un script a été découpé (MySQL). */
  statements?: number;
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
  query(sql: string, params?: unknown[], cancel?: CancelToken): Promise<QueryResult>;
  /**
   * Exécute plusieurs instructions l'une après l'autre sur UNE connexion (variables, tables
   * temporaires et transactions restent visibles d'une instruction à l'autre) ; renvoie le
   * résultat de la dernière. Absent pour PostgreSQL, qui accepte déjà plusieurs instructions.
   */
  script?(statements: string[], cancel?: CancelToken): Promise<QueryResult>;
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

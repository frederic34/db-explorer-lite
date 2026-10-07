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
  /** Dossier de l'arbre dans lequel la connexion est rangée (un seul niveau). */
  group?: string;
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
  /** Nombre de lignes : estimation du catalogue (MySQL, PostgreSQL) ou comptage exact (SQLite) ; absent pour une vue ou si inconnu. */
  rows?: number;
  /** Vrai quand `rows` est une estimation. */
  approx?: boolean;
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

/** Clé étrangère d'une table « enfant » vers la table consultée. */
export interface Referrer {
  container: string;
  table: string;
  /** Colonne de la table enfant. */
  column: string;
  /** Colonne référencée de la table consultée. */
  refColumn: string;
}

export interface StructureColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  /** Valeur par défaut telle qu'écrite par le serveur (expression SQL), ou null. */
  default: string | null;
  /** auto_increment, identité, colonne générée… */
  extra?: string;
  comment?: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  /** btree, hash, gin… */
  method?: string;
}

export interface ConstraintInfo {
  name: string;
  kind: 'PRIMARY KEY' | 'UNIQUE' | 'FOREIGN KEY' | 'CHECK' | 'EXCLUDE';
  /** Définition lisible : colonnes, table référencée, expression… */
  definition: string;
}

export interface TableStructure {
  isView: boolean;
  columns: StructureColumn[];
  indexes: IndexInfo[];
  constraints: ConstraintInfo[];
  /** Instruction(s) CREATE reconstituées ou fournies par le serveur. */
  ddl: string;
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
  /**
   * Script de plusieurs instructions : le résultat de chacune, dans l'ordre (le résultat principal
   * est celui de la dernière). `durationMs` d'un élément vaut 0 quand le serveur ne le fournit pas.
   */
  sets?: QueryResult[];
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
  /** Clés étrangères (sur une seule colonne) d'autres tables qui pointent vers cette table. */
  listReferrers(container: string, table: string): Promise<Referrer[]>;
  /** Colonnes détaillées, index, contraintes et DDL d'une table ou d'une vue. */
  describeTable(container: string, table: string): Promise<TableStructure>;
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

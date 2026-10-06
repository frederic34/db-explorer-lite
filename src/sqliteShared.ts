// Constantes et messages partagés entre le pilote SQLite et son thread de travail.

/** Taille maximale d'un fichier chargé en mémoire. */
export const SQLITE_MAX_BYTES = 300 * 1024 * 1024;

export interface WorkerData {
  file: string;
  wasmPath: string;
}

export type WorkerRequest =
  | { id: number; op: 'open' }
  | { id: number; op: 'rows'; sql: string; params: unknown[] }
  | { id: number; op: 'query'; sql: string; params: unknown[]; max: number };

/** Résultat d'une instruction : au plus `max` lignes sont renvoyées, `total` compte toutes les lignes. */
export interface RawSet {
  columns: string[];
  values: unknown[][];
  total: number;
}

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

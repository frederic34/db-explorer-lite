// Thread de travail SQLite : charge le fichier avec sql.js (WebAssembly) et exécute les requêtes
// hors du processus de l'extension, pour ne pas le bloquer et pouvoir interrompre une requête
// longue (le pilote arrête alors tout le thread).
import * as fs from 'fs';
import { parentPort, workerData } from 'worker_threads';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { RawSet, SQLITE_MAX_BYTES, WorkerData, WorkerRequest, WorkerResponse } from './sqliteShared';

const data = workerData as WorkerData;
const tw = (fr: string, en: string): string => (data.fr === false ? en : fr);
let SQL: Promise<SqlJsStatic> | undefined;
let db: Database | undefined;
let stamp = '';

function engine(): Promise<SqlJsStatic> {
  if (!SQL) {
    const bin = fs.readFileSync(data.wasmPath);
    SQL = initSqlJs({ wasmBinary: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer });
  }
  return SQL;
}

/** (Re)charge le fichier s'il a changé depuis la dernière requête. */
async function open(): Promise<Database> {
  const file = data.file;
  if (!file) {
    throw new Error(tw('Aucun fichier SQLite indiqué.', 'No SQLite file specified.'));
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch (err) {
    throw new Error(
      tw(
        `Fichier introuvable ou illisible : ${file} (${(err as NodeJS.ErrnoException).code ?? 'erreur'})`,
        `File not found or unreadable: ${file} (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
      ),
    );
  }
  if (!st.isFile()) {
    throw new Error(tw(`Ce n'est pas un fichier : ${file}`, `Not a file: ${file}`));
  }
  if (st.size > SQLITE_MAX_BYTES) {
    throw new Error(
      tw(
        `Fichier trop volumineux (${Math.round(st.size / 1048576)} Mo) : la limite est de ${SQLITE_MAX_BYTES / 1048576} Mo, le fichier est chargé en mémoire.`,
        `File too large (${Math.round(st.size / 1048576)} MB): the limit is ${SQLITE_MAX_BYTES / 1048576} MB, the file is loaded into memory.`,
      ),
    );
  }
  const now = `${st.mtimeMs}:${st.size}`;
  if (db && now === stamp) {
    return db;
  }
  const engineReady = await engine();
  const bytes = fs.readFileSync(file);
  db?.close();
  db = undefined;
  const fresh = new engineReady.Database(bytes);
  try {
    fresh.exec('PRAGMA query_only = ON');
    fresh.exec('SELECT count(*) FROM sqlite_master'); // échoue si ce n'est pas une base SQLite
  } catch (err) {
    fresh.close();
    throw new Error(
      tw(
        `Ce fichier n'est pas une base SQLite valide : ${(err as Error).message}`,
        `This file is not a valid SQLite database: ${(err as Error).message}`,
      ),
    );
  }
  db = fresh;
  stamp = now;
  return fresh;
}

function stepAll(database: Database, sql: string, params: unknown[], max: number): RawSet {
  const stmt = database.prepare(sql);
  try {
    stmt.bind(params as never);
    const columns = stmt.getColumnNames();
    const values: unknown[][] = [];
    let total = 0;
    while (stmt.step()) {
      total++;
      if (values.length < max) {
        values.push(stmt.get() as unknown[]);
      }
    }
    return { columns, values, total };
  } finally {
    stmt.free();
  }
}

async function handle(req: WorkerRequest): Promise<unknown> {
  const database = await open();
  switch (req.op) {
    case 'open':
      return null;
    case 'rows':
      return stepAll(database, req.sql, req.params, Number.MAX_SAFE_INTEGER).values;
    case 'query': {
      if (req.params.length > 0) {
        return [stepAll(database, req.sql, req.params, req.max)];
      }
      // Plusieurs instructions possibles : un résultat par instruction qui renvoie des colonnes.
      return database.exec(req.sql).map((r) => ({ columns: r.columns, values: r.values.slice(0, req.max), total: r.values.length }));
    }
  }
}

parentPort?.on('message', (req: WorkerRequest) => {
  handle(req).then(
    (result) => parentPort?.postMessage({ id: req.id, ok: true, result } satisfies WorkerResponse),
    (err: unknown) =>
      parentPort?.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse),
  );
});

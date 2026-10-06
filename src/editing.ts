import { ColumnInfo, DbType, WriteStatement } from './types';
import { quoteIdent } from './util';

/** Colonnes dont la valeur affichée (texte) ne peut pas être réécrite sans risque : binaire, géométrie… */
const MYSQL_NOT_EDITABLE =
  /^((tiny|medium|long)?blob|(var)?binary|bit|geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b/i;

/**
 * PostgreSQL : liste blanche des types dont l'affichage en texte se relit tel quel
 * (tableaux, intervalles, types géométriques… sont exclus).
 */
const PG_EDITABLE = new Set([
  'smallint',
  'integer',
  'bigint',
  'numeric',
  'real',
  'double precision',
  'text',
  'character varying',
  'character',
  'boolean',
  'date',
  'time without time zone',
  'time with time zone',
  'timestamp without time zone',
  'timestamp with time zone',
  'uuid',
  'json',
  'jsonb',
  'USER-DEFINED',
]);

export function isEditableType(dbType: DbType, columnType: string): boolean {
  const t = columnType.trim();
  return dbType === 'mysql' ? !MYSQL_NOT_EDITABLE.test(t) : PG_EDITABLE.has(t);
}

export interface EditPlan {
  /** Indices (dans les colonnes du résultat) de la clé primaire. */
  pk: number[];
  /** Par colonne : la valeur peut être modifiée. */
  editable: boolean[];
  /** Par colonne : NULL autorisé. */
  nullable: boolean[];
}

/** Détermine si un résultat peut être édité, ligne par ligne, via la clé primaire de la table. */
export function planEditing(
  dbType: DbType,
  resultColumns: string[],
  tableColumns: ColumnInfo[],
): { plan: EditPlan } | { reason: string } {
  const same =
    resultColumns.length === tableColumns.length &&
    resultColumns.every((name, j) => name === tableColumns[j].name);
  if (!same) {
    return { reason: 'les colonnes du résultat ne correspondent pas à celles de la table' };
  }
  const pk = tableColumns.flatMap((c, j) => (c.primaryKey ? [j] : []));
  if (pk.length === 0) {
    return { reason: "cette table n'a pas de clé primaire" };
  }
  return {
    plan: {
      pk,
      editable: tableColumns.map((c) => !c.primaryKey && isEditableType(dbType, c.type)),
      nullable: tableColumns.map((c) => c.nullable),
    },
  };
}

const placeholder = (dbType: DbType, n: number): string => (dbType === 'mysql' ? '?' : `$${n}`);

const qualified = (dbType: DbType, container: string, table: string): string =>
  `${quoteIdent(dbType, container)}.${quoteIdent(dbType, table)}`;

export function buildUpdate(
  dbType: DbType,
  container: string,
  table: string,
  columns: string[],
  setIdx: number[],
  setValues: (string | null)[],
  pkIdx: number[],
  pkValues: (string | null)[],
): WriteStatement {
  const q = (name: string) => quoteIdent(dbType, name);
  const sets = setIdx.map((j, k) => `${q(columns[j])} = ${placeholder(dbType, k + 1)}`).join(', ');
  const where = pkIdx
    .map((j, k) => `${q(columns[j])} = ${placeholder(dbType, setIdx.length + k + 1)}`)
    .join(' AND ');
  return {
    sql: `UPDATE ${qualified(dbType, container, table)} SET ${sets} WHERE ${where}`,
    params: [...setValues, ...pkValues],
    expect: 1,
  };
}

export function buildSelectRow(
  dbType: DbType,
  container: string,
  table: string,
  pkNames: string[],
  pkValues: (string | null)[],
): { sql: string; params: unknown[] } {
  const where = pkNames
    .map((name, k) => `${quoteIdent(dbType, name)} = ${placeholder(dbType, k + 1)}`)
    .join(' AND ');
  return {
    sql: `SELECT * FROM ${qualified(dbType, container, table)} WHERE ${where}`,
    params: pkValues,
  };
}

/** Une instruction DELETE par lot de `chunkSize` lignes, identifiées par leur clé primaire. */
export function buildDeletes(
  dbType: DbType,
  container: string,
  table: string,
  pkNames: string[],
  pkRows: (string | null)[][],
  chunkSize = 500,
): WriteStatement[] {
  const cols = pkNames.map((n) => quoteIdent(dbType, n));
  const statements: WriteStatement[] = [];
  for (let start = 0; start < pkRows.length; start += chunkSize) {
    const chunk = pkRows.slice(start, start + chunkSize);
    let n = 0;
    const tuples = chunk.map((row) => {
      const marks = row.map(() => placeholder(dbType, ++n));
      return pkNames.length === 1 ? marks[0] : `(${marks.join(', ')})`;
    });
    const left = pkNames.length === 1 ? cols[0] : `(${cols.join(', ')})`;
    statements.push({
      sql: `DELETE FROM ${qualified(dbType, container, table)} WHERE ${left} IN (${tuples.join(', ')})`,
      params: chunk.flat(),
      expect: chunk.length,
    });
  }
  return statements;
}

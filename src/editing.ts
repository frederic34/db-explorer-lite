import { ColumnInfo, DbType, WriteStatement } from './types';
import { quoteIdent } from './util';
import { t } from './i18n';

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
  if (dbType === 'sqlite') {
    return !/blob/i.test(t);
  }
  return dbType === 'mysql' ? !MYSQL_NOT_EDITABLE.test(t) : PG_EDITABLE.has(t);
}

/** Colonne binaire / géométrique : sans sens en recherche texte. */
export function isBinaryLike(dbType: DbType, columnType: string): boolean {
  const t = columnType.trim();
  if (dbType === 'sqlite') {
    return /blob/i.test(t);
  }
  return dbType === 'mysql' ? MYSQL_NOT_EDITABLE.test(t) : t === 'bytea';
}

export interface EditPlan {
  /** Indices (dans les colonnes du résultat) de la clé primaire. */
  pk: number[];
  /** Par colonne : la valeur peut être modifiée. */
  editable: boolean[];
  /** Par colonne : une valeur peut être fournie à l'insertion (clé primaire comprise). */
  insertable: boolean[];
  /** Par colonne : valeur par défaut / auto-incrément (la colonne peut être omise à l'insertion). */
  hasDefault: boolean[];
  /** Par colonne : NULL autorisé. */
  nullable: boolean[];
  /** Par colonne : type d'éditeur adapté (json, date, datetime, time) ou '' pour du texte libre. */
  kinds: EditorKind[];
}

export type EditorKind = '' | 'json' | 'date' | 'datetime' | 'time';

/**
 * Éditeur adapté au type de la colonne. Les types avec fuseau horaire restent en texte libre : un
 * sélecteur de date locale ne peut pas porter le décalage.
 */
export function editorKind(dbType: DbType, columnType: string): EditorKind {
  const t = columnType.trim().toLowerCase().replace(/\(\d+\)/g, '').replace(/\s+/g, ' ');
  if (/with time zone|timetz|timestamptz/.test(t) && !/without time zone/.test(t)) {
    return '';
  }
  if (t === 'json' || t === 'jsonb') {
    return dbType === 'sqlite' ? '' : 'json';
  }
  if (t === 'date') {
    return 'date';
  }
  if (t === 'datetime' || t === 'timestamp' || t === 'timestamp without time zone') {
    return 'datetime';
  }
  if (t === 'time' || t === 'time without time zone') {
    return 'time';
  }
  return '';
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
    return { reason: t('les colonnes du résultat ne correspondent pas à celles de la table', 'the result columns do not match the table columns') };
  }
  const pk = tableColumns.flatMap((c, j) => (c.primaryKey ? [j] : []));
  if (pk.length === 0) {
    return { reason: t("cette table n'a pas de clé primaire", 'this table has no primary key') };
  }
  return {
    plan: {
      pk,
      editable: tableColumns.map(
        (c) => !c.primaryKey && !c.generated && isEditableType(dbType, c.type),
      ),
      insertable: tableColumns.map((c) => !c.generated && isEditableType(dbType, c.type)),
      hasDefault: tableColumns.map((c) => c.hasDefault),
      nullable: tableColumns.map((c) => c.nullable),
      kinds: tableColumns.map((c) => editorKind(dbType, c.type)),
    },
  };
}

const placeholder = (dbType: DbType, n: number): string => (dbType === 'postgres' ? `$${n}` : '?');

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

/**
 * INSERT d'une ligne. Seules les colonnes de `setIdx` sont renseignées, les autres prennent leur
 * valeur par défaut. PostgreSQL : RETURNING * pour relire la ligne insérée.
 */
export function buildInsert(
  dbType: DbType,
  container: string,
  table: string,
  columns: string[],
  setIdx: number[],
  values: (string | null)[],
): { sql: string; params: unknown[] } {
  const target = qualified(dbType, container, table);
  const returning = dbType === 'postgres' ? ' RETURNING *' : '';
  if (setIdx.length === 0) {
    return {
      sql:
        dbType === 'mysql'
          ? `INSERT INTO ${target} () VALUES ()`
          : `INSERT INTO ${target} DEFAULT VALUES${returning}`, // PostgreSQL et SQLite
      params: [],
    };
  }
  const cols = setIdx.map((j) => quoteIdent(dbType, columns[j])).join(', ');
  const marks = setIdx.map((_, k) => placeholder(dbType, k + 1)).join(', ');
  return {
    sql: `INSERT INTO ${target} (${cols}) VALUES (${marks})${returning}`,
    params: values,
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

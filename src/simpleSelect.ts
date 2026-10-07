import { DbType } from './types';
import { scanSql } from './sqlGuard';

export interface SimpleSelect {
  /** Base / schéma explicite, ou undefined si seul le nom de la table est donné. */
  container?: string;
  table: string;
}

const IDENT = '(?:"(?:[^"]|"")+"|`(?:[^`]|``)+`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*)';
const NOT_ALIAS =
  'WHERE|ORDER|LIMIT|OFFSET|FETCH|FOR|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|NATURAL|UNION|INTERSECT|EXCEPT|GROUP|HAVING|WINDOW|USING|ON';
const RE = new RegExp(
  `^\\s*SELECT\\s+\\*\\s+FROM\\s+(${IDENT})(?:\\s*\\.\\s*(${IDENT}))?` +
    `(?:\\s+(?!(?:${NOT_ALIAS})\\b)(?:AS\\s+)?[A-Za-z_][A-Za-z0-9_]*)?` +
    `\\s*(?:(?:\\s|^)(?:WHERE|ORDER\\s+BY|LIMIT|OFFSET|FETCH|FOR)\\b[\\s\\S]*)?$`,
  'i',
);
const FORBIDDEN = /\b(JOIN|UNION|INTERSECT|EXCEPT|GROUP|HAVING|DISTINCT|INTO|WINDOW)\b/i;

function unquote(id: string): string {
  const c = id[0];
  if (c === '"') {
    return id.slice(1, -1).replace(/""/g, '"');
  }
  if (c === '`') {
    return id.slice(1, -1).replace(/``/g, '`');
  }
  if (c === '[') {
    return id.slice(1, -1);
  }
  return id;
}

/**
 * Reconnaît `SELECT * FROM [schéma.]table [alias] [WHERE …] [ORDER BY …] [LIMIT …]` : une seule table,
 * sans jointure, regroupement ni opération d'ensemble. Dans ce cas seulement, les lignes du résultat
 * correspondent une à une à des lignes de la table et peuvent être modifiées via leur clé primaire.
 */
export function parseSimpleSelect(sql: string, dbType: DbType): SimpleSelect | undefined {
  const { statements } = scanSql(sql, dbType);
  if (statements.length !== 1) {
    return undefined;
  }
  const text = statements[0].sql.replace(/[;\s]+$/, '');
  if (FORBIDDEN.test(statements[0].masked)) {
    return undefined;
  }
  const m = RE.exec(text);
  if (!m) {
    return undefined;
  }
  return m[2] ? { container: unquote(m[1]), table: unquote(m[2]) } : { table: unquote(m[1]) };
}

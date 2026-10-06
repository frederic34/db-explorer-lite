import { isBinaryLike } from './editing';
import { ColumnInfo, DbType } from './types';
import { quoteIdent } from './util';

export interface BrowseQuery {
  dbType: DbType;
  container: string;
  table: string;
  columns: ColumnInfo[];
  pageSize: number;
  offset: number;
  sort?: { column: string; dir: 'asc' | 'desc' };
  filter?: string;
}

/** Caractère d'échappement des jokers LIKE (choisi pour ne dépendre ni de NO_BACKSLASH_ESCAPES ni du SGBD). */
const ESC = '!';

/** Motif LIKE « contient » : %, _ et le caractère d'échappement du terme saisi sont neutralisés. */
export function likePattern(term: string): string {
  return '%' + term.replace(/[!%_]/g, (c) => ESC + c) + '%';
}

const target = (b: BrowseQuery): string =>
  `${quoteIdent(b.dbType, b.container)}.${quoteIdent(b.dbType, b.table)}`;

/** Recherche du terme dans toutes les colonnes textuelles (conversion en texte, sans tenir compte de la casse). */
function whereClause(b: BrowseQuery): { sql: string; params: unknown[] } {
  const term = (b.filter ?? '').trim();
  if (!term) {
    return { sql: '', params: [] };
  }
  const cols = b.columns.filter((c) => !isBinaryLike(b.dbType, c.type));
  if (cols.length === 0) {
    return { sql: ' WHERE 1 = 0', params: [] };
  }
  const pattern = likePattern(term);
  if (b.dbType === 'postgres') {
    const preds = cols.map((c) => `${quoteIdent('postgres', c.name)}::text ILIKE $1 ESCAPE '${ESC}'`);
    return { sql: ` WHERE ${preds.join(' OR ')}`, params: [pattern] };
  }
  const preds = cols.map((c) => `CAST(${quoteIdent('mysql', c.name)} AS CHAR) LIKE ? ESCAPE '${ESC}'`);
  return { sql: ` WHERE ${preds.join(' OR ')}`, params: cols.map(() => pattern) };
}

/**
 * Une page de lignes. On demande une ligne de plus que la taille de page pour savoir s'il y a une
 * page suivante. L'ordre est toujours terminé par la clé primaire : sans cela, deux pages
 * consécutives pourraient se chevaucher ou omettre des lignes (tri sur une colonne à valeurs égales).
 */
export function buildPageQuery(b: BrowseQuery): { sql: string; params: unknown[] } {
  const q = (name: string) => quoteIdent(b.dbType, name);
  const where = whereClause(b);

  const order: string[] = [];
  if (b.sort) {
    order.push(`${q(b.sort.column)} ${b.sort.dir === 'desc' ? 'DESC' : 'ASC'}`);
  }
  for (const c of b.columns) {
    if (c.primaryKey && c.name !== b.sort?.column) {
      order.push(q(c.name));
    }
  }
  const orderBy = order.length > 0 ? ` ORDER BY ${order.join(', ')}` : '';

  const limit = Math.max(1, Math.floor(b.pageSize));
  const offset = Math.max(0, Math.floor(b.offset));
  return {
    sql: `SELECT * FROM ${target(b)}${where.sql}${orderBy} LIMIT ${limit + 1} OFFSET ${offset}`,
    params: where.params,
  };
}

export function buildCountQuery(b: BrowseQuery): { sql: string; params: unknown[] } {
  const where = whereClause(b);
  return { sql: `SELECT COUNT(*) FROM ${target(b)}${where.sql}`, params: where.params };
}

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
  /** Égalité exacte sur une colonne (navigation par clé étrangère) ; se combine au filtre par ET. */
  where?: { column: string; value: string };
}

/** Caractère d'échappement des jokers LIKE (choisi pour ne dépendre ni de NO_BACKSLASH_ESCAPES ni du SGBD). */
const ESC = '!';

/** Motif LIKE « contient » : %, _ et le caractère d'échappement du terme saisi sont neutralisés. */
export function likePattern(term: string): string {
  return '%' + term.replace(/[!%_]/g, (c) => ESC + c) + '%';
}

const target = (b: BrowseQuery): string =>
  `${quoteIdent(b.dbType, b.container)}.${quoteIdent(b.dbType, b.table)}`;

/**
 * Clause WHERE : égalité exacte (navigation) ET recherche du terme dans toutes les colonnes
 * textuelles (conversion en texte, sans tenir compte de la casse).
 */
function whereClause(b: BrowseQuery): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const mark = (): string => (b.dbType === 'postgres' ? `$${params.length}` : '?');
  const parts: string[] = [];

  if (b.where) {
    params.push(b.where.value);
    parts.push(`${quoteIdent(b.dbType, b.where.column)} = ${mark()}`);
  }

  const term = (b.filter ?? '').trim();
  if (term) {
    const cols = b.columns.filter((c) => !isBinaryLike(b.dbType, c.type));
    if (cols.length === 0) {
      parts.push('1 = 0');
    } else {
      const pattern = likePattern(term);
      if (b.dbType === 'postgres') {
        params.push(pattern);
        const m = mark(); // un seul paramètre, réutilisé pour chaque colonne
        parts.push('(' + cols.map((c) => `${quoteIdent('postgres', c.name)}::text ILIKE ${m} ESCAPE '${ESC}'`).join(' OR ') + ')');
      } else {
        const preds = cols.map((c) => {
          params.push(pattern);
          return `CAST(${quoteIdent('mysql', c.name)} AS CHAR) LIKE ? ESCAPE '${ESC}'`;
        });
        parts.push('(' + preds.join(' OR ') + ')');
      }
    }
  }
  return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params };
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

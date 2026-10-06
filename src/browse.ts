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
  /** Pagination par clé : valeurs des colonnes de clé primaire de la dernière ligne de la page précédente. */
  after?: unknown[];
}

export type ColumnOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'starts' | 'ends' | 'null' | 'notnull';
export interface ColumnCondition {
  column: string;
  op: ColumnOp;
  value: string;
}

const WORD_OPS: [RegExp, ColumnOp][] = [
  [/^(?:non\s+vide|not\s+null|is\s+not\s+null)$/i, 'notnull'],
  [/^(?:vide|null|is\s+null)$/i, 'null'],
];
const INFIX_OPS: [string, ColumnOp][] = [
  ['>=', '>='], ['<=', '<='], ['!=', '!='], ['<>', '!='], ['=', '='], ['>', '>'], ['<', '<'], ['~', 'contains'],
  ['contient', 'contains'], ['contains', 'contains'], ['commence par', 'starts'], ['commence', 'starts'],
  ['starts', 'starts'], ['finit par', 'ends'], ['finit', 'ends'], ['ends', 'ends'],
];

function unquote(v: string): string {
  const m = /^(['"])(.*)\1$/.exec(v);
  return m ? m[2] : v;
}

function parseCondition(piece: string, columns: ColumnInfo[]): ColumnCondition | undefined {
  const lower = piece.toLowerCase();
  // colonnes les plus longues d'abord : « prix ttc » avant « prix »
  const sorted = [...columns].sort((a, b) => b.name.length - a.name.length);
  for (const c of sorted) {
    const name = c.name.toLowerCase();
    if (!lower.startsWith(name)) {
      continue;
    }
    const rest = piece.slice(name.length);
    const afterName = rest.trim();
    if (rest !== '' && !/^\s|^[<>=!~]/.test(rest)) {
      continue; // « prixx » n'est pas la colonne « prix »
    }
    for (const [re, op] of WORD_OPS) {
      if (re.test(afterName)) {
        return { column: c.name, op, value: '' };
      }
    }
    for (const [token, op] of INFIX_OPS) {
      const alpha = /^[a-z]/i.test(token);
      if (afterName.toLowerCase().startsWith(token) && (!alpha || /^\s/.test(afterName.slice(token.length)))) {
        const value = unquote(afterName.slice(token.length).trim());
        if (value !== '') {
          return { column: c.name, op, value };
        }
      }
    }
  }
  return undefined;
}

/**
 * Le champ de filtre accepte des conditions par colonne séparées par « ; » (`prix > 20 ; nom contient dupont ;
 * stock vide`) ; ce qui n'en est pas une est cherché dans toutes les colonnes, comme avant.
 */
export function parseFilter(text: string, columns: ColumnInfo[]): { conditions: ColumnCondition[]; term: string } {
  const pieces = text.split(';').map((x) => x.trim()).filter(Boolean);
  const conditions: ColumnCondition[] = [];
  const rest: string[] = [];
  for (const piece of pieces) {
    const c = parseCondition(piece, columns);
    if (c) {
      conditions.push(c);
    } else {
      rest.push(piece);
    }
  }
  if (conditions.length === 0) {
    return { conditions, term: text.trim() };
  }
  return { conditions, term: rest.join('; ') };
}

/** Types de clé dont la valeur se relit et se rejoue sans perte (entiers, texte, uuid). */
const KEYSET_TYPE = /int|serial|char|text|uuid/i;

/** Colonnes de la pagination par clé, ou null si elle est impossible (tri choisi, pas de clé, type exotique). */
export function keysetColumns(b: Pick<BrowseQuery, 'sort' | 'columns' | 'dbType'>): ColumnInfo[] | null {
  if (b.sort) {
    return null;
  }
  const pk = b.columns.filter((c) => c.primaryKey);
  if (pk.length === 0 || pk.some((c) => !KEYSET_TYPE.test(c.type) || /\[\]|tsvector/i.test(c.type))) {
    return null;
  }
  return pk;
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

  const { conditions, term } = parseFilter((b.filter ?? '').trim(), b.columns);
  for (const c of conditions) {
    const col = quoteIdent(b.dbType, c.column);
    if (c.op === 'null' || c.op === 'notnull') {
      parts.push(`${col} IS ${c.op === 'null' ? '' : 'NOT '}NULL`);
    } else if (c.op === 'contains' || c.op === 'starts' || c.op === 'ends') {
      const esc = c.value.replace(/[!%_]/g, (ch) => ESC + ch);
      params.push((c.op === 'contains' || c.op === 'ends' ? '%' : '') + esc + (c.op === 'contains' || c.op === 'starts' ? '%' : ''));
      if (b.dbType === 'postgres') {
        parts.push(`${col}::text ILIKE ${mark()} ESCAPE '${ESC}'`);
      } else {
        parts.push(`CAST(${col} AS ${b.dbType === 'sqlite' ? 'TEXT' : 'CHAR'}) LIKE ? ESCAPE '${ESC}'`);
      }
    } else {
      params.push(c.value);
      parts.push(`${col} ${c.op} ${mark()}`);
    }
  }

  const ks = b.after ? keysetColumns(b) : null;
  if (ks && b.after && b.after.length === ks.length) {
    const marks = b.after.map((v) => {
      params.push(typeof v === 'bigint' ? v.toString() : v);
      return mark();
    });
    const names = ks.map((c) => quoteIdent(b.dbType, c.name));
    parts.push(ks.length === 1 ? `${names[0]} > ${marks[0]}` : `(${names.join(', ')}) > (${marks.join(', ')})`);
  }

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
        const asText = b.dbType === 'sqlite' ? 'TEXT' : 'CHAR';
        const preds = cols.map((c) => {
          params.push(pattern);
          return `CAST(${quoteIdent(b.dbType, c.name)} AS ${asText}) LIKE ? ESCAPE '${ESC}'`;
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
  const keyed = !!b.after && keysetColumns(b)?.length === b.after.length;
  const offset = keyed ? 0 : Math.max(0, Math.floor(b.offset));
  return {
    sql: `SELECT * FROM ${target(b)}${where.sql}${orderBy} LIMIT ${limit + 1} OFFSET ${offset}`,
    params: where.params,
  };
}

export function buildCountQuery(b: BrowseQuery): { sql: string; params: unknown[] } {
  const where = whereClause(b);
  return { sql: `SELECT COUNT(*) FROM ${target(b)}${where.sql}`, params: where.params };
}

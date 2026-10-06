import { scanSql } from './sqlGuard';
import { ColumnInfo, DbType } from './types';
import { quoteIdent } from './util';

/** Table citée dans une requête (FROM, JOIN, UPDATE, INTO) avec son éventuel alias. */
export interface TableRef {
  /** Base / schéma si la table est qualifiée. */
  container?: string;
  table: string;
  alias?: string;
}

export interface CompletionContext {
  /** Qualificatifs saisis avant le point : « a. » → ['a'], « s.t. » → ['s', 't']. */
  qualifiers: string[];
  /** Début du mot en cours de saisie. */
  prefix: string;
  /** Dernier mot-clé de clause avant le curseur (FROM, WHERE, SELECT…), en majuscules. */
  clause: string;
}

export interface Completion {
  label: string;
  kind: 'table' | 'view' | 'column' | 'schema' | 'keyword';
  detail?: string;
  insertText: string;
}

/** Ce que l'auto-complétion sait du serveur (déjà chargé en mémoire). */
export interface SchemaView {
  dbType: DbType;
  containers: string[];
  /** Base / schéma par défaut : ses tables s'écrivent sans qualificatif. */
  defaultContainer?: string;
  tables(container: string): { name: string; isView: boolean }[] | undefined;
  columns(container: string, table: string): ColumnInfo[] | undefined;
}

const NOT_ALIAS = new Set([
  'WHERE', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'NATURAL', 'SET', 'USING',
  'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'UNION', 'INTERSECT', 'EXCEPT', 'VALUES', 'SELECT', 'WINDOW', 'FOR',
  'RETURNING', 'AS', 'OFFSET', 'FETCH', 'LATERAL', 'STRAIGHT_JOIN', 'PARTITION', 'USE', 'IGNORE', 'FORCE',
]);

const CLAUSES = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'ON', 'GROUP', 'ORDER', 'HAVING', 'SET', 'UPDATE', 'INTO', 'VALUES',
  'TABLE', 'TRUNCATE', 'DESCRIBE', 'DESC', 'LIMIT', 'RETURNING', 'USING', 'DELETE', 'INSERT',
];
const TABLE_CLAUSES = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE', 'TRUNCATE', 'DESCRIBE', 'DESC']);

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'IS NULL', 'IS NOT NULL', 'ORDER BY',
  'GROUP BY', 'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT', 'AS', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
  'ON', 'UNION', 'UNION ALL', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE',
  'DROP TABLE', 'COUNT(*)', 'SUM(', 'AVG(', 'MIN(', 'MAX(', 'CASE WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC',
  'EXISTS', 'WITH', 'EXPLAIN', 'RETURNING', 'COALESCE(', 'CAST(',
];

/** Texte de l'instruction qui contient `offset`, et la partie située avant le curseur. */
export function currentStatement(
  text: string,
  offset: number,
  dbType: DbType,
): { statement: string; before: string } {
  const { statements } = scanSql(text, dbType);
  const found = statements.find((s) => offset >= s.from && offset <= s.to);
  const from = found ? found.from : offset;
  const to = found ? found.to : offset;
  return { statement: text.slice(from, to), before: text.slice(from, offset) };
}

/** Contexte de saisie à la fin de `before` ; undefined si le curseur est dans une chaîne ou un commentaire. */
export function analyzeContext(before: string, dbType: DbType): CompletionContext | undefined {
  const { statements, unterminated } = scanSql(before, dbType);
  if (unterminated) {
    return undefined;
  }
  const last = statements[statements.length - 1];
  const masked = last && last.to === before.length ? last.masked : '';
  // `masked` est sans espaces de fin : après « WHERE␣ », le mot en cours est vide, pas « WHERE ».
  const m = /\s$/.test(before) ? null : /((?:[A-Za-z_][\w$]*\.){0,2})([\w$]*)$/.exec(masked);
  const qualifiers = m && m[1] ? m[1].split('.').filter(Boolean) : [];
  const prefix = m ? m[2] : '';
  const head = m ? masked.slice(0, masked.length - m[0].length) : masked;

  let clause = '';
  const re = new RegExp(`\\b(${CLAUSES.join('|')})\\b`, 'gi');
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(head)) !== null) {
    clause = hit[1].toUpperCase();
  }
  return { qualifiers, prefix, clause };
}

/** Tables citées dans l'instruction (le texte situé après le curseur compte : « SELECT | FROM t x »). */
export function referencedTables(statement: string, dbType: DbType): TableRef[] {
  const { statements } = scanSql(statement, dbType);
  const refs: TableRef[] = [];
  const ident = '[A-Za-z_][\\w$]*';
  const ref = `(${ident})(?:\\.(${ident}))?(?:\\s+(?:AS\\s+)?(${ident}))?`;
  const add = (a: string, b: string | undefined, alias: string | undefined) => {
    const candidate = alias && !NOT_ALIAS.has(alias.toUpperCase()) ? alias : undefined;
    refs.push(b ? { container: a, table: b, alias: candidate } : { table: a, alias: candidate });
  };
  for (const st of statements) {
    const m = st.masked;
    const first = new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+${ref}`, 'gi');
    let hit: RegExpExecArray | null;
    while ((hit = first.exec(m)) !== null) {
      add(hit[1], hit[2], hit[3]);
    }
    // FROM a x, b y : tables suivantes de la liste (jusqu'à la clause suivante)
    const list = /\bFROM\b([^()]*?)(?=\b(?:WHERE|GROUP|ORDER|HAVING|LIMIT|UNION|JOIN|ON|SET|RETURNING|WINDOW|FOR)\b|\)|$)/gi;
    while ((hit = list.exec(m)) !== null) {
      const parts = hit[1].split(',').slice(1);
      for (const part of parts) {
        const r = new RegExp(`^\\s*${ref}\\s*$`, 'i').exec(part);
        if (r) {
          add(r[1], r[2], r[3]);
        }
      }
    }
  }
  return refs;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Retrouve la base / le schéma d'une table citée (qualifiée, ou cherchée dans le défaut puis partout). */
export function resolveTable(
  ref: { container?: string; table: string },
  view: SchemaView,
): { container: string; table: string } | undefined {
  const containers = ref.container
    ? view.containers.filter((c) => same(c, ref.container as string))
    : [...(view.defaultContainer ? [view.defaultContainer] : []), ...view.containers];
  for (const c of containers) {
    const t = view.tables(c)?.find((x) => same(x.name, ref.table));
    if (t) {
      return { container: c, table: t.name };
    }
  }
  return undefined;
}

/** Tables dont il faut connaître les colonnes pour répondre à ce contexte. */
export function tablesNeeded(
  ctx: CompletionContext,
  refs: TableRef[],
  view: SchemaView,
): { container: string; table: string }[] {
  const out: { container: string; table: string }[] = [];
  const push = (t?: { container: string; table: string }) => {
    if (t && !out.some((o) => o.container === t.container && o.table === t.table)) {
      out.push(t);
    }
  };
  if (ctx.qualifiers.length === 2) {
    push(resolveTable({ container: ctx.qualifiers[0], table: ctx.qualifiers[1] }, view));
  } else if (ctx.qualifiers.length === 1) {
    const q = ctx.qualifiers[0];
    const viaAlias = refs.find((r) => r.alias && same(r.alias, q));
    push(resolveTable(viaAlias ?? { table: q }, view));
  } else if (!TABLE_CLAUSES.has(ctx.clause)) {
    refs.forEach((r) => push(resolveTable(r, view)));
  }
  return out;
}

function needsQuote(dbType: DbType, name: string): boolean {
  return dbType === 'mysql' ? !/^[A-Za-z_][\w$]*$/.test(name) : !/^[a-z_][a-z0-9_$]*$/.test(name);
}
const ident = (dbType: DbType, name: string): string => (needsQuote(dbType, name) ? quoteIdent(dbType, name) : name);

/** Propositions pour un contexte donné ; ne fait aucun accès réseau (tout vient de `view`). */
export function complete(ctx: CompletionContext, refs: TableRef[], view: SchemaView): Completion[] {
  const out: Completion[] = [];
  const t = view.dbType;
  const columnsOf = (target: { container: string; table: string } | undefined, tag?: string): void => {
    if (!target) {
      return;
    }
    for (const c of view.columns(target.container, target.table) ?? []) {
      out.push({
        label: c.name,
        kind: 'column',
        detail: `${tag ?? target.table} · ${c.type}${c.primaryKey ? ' · clé primaire' : ''}`,
        insertText: ident(t, c.name),
      });
    }
  };
  const tablesOf = (container: string, qualify: boolean): void => {
    for (const tb of view.tables(container) ?? []) {
      out.push({
        label: qualify ? `${container}.${tb.name}` : tb.name,
        kind: tb.isView ? 'view' : 'table',
        detail: `${container}${tb.isView ? ' · vue' : ''}`,
        insertText: (qualify ? ident(t, container) + '.' : '') + ident(t, tb.name),
      });
    }
  };

  if (ctx.qualifiers.length === 2) {
    columnsOf(resolveTable({ container: ctx.qualifiers[0], table: ctx.qualifiers[1] }, view));
    return out;
  }
  if (ctx.qualifiers.length === 1) {
    const q = ctx.qualifiers[0];
    const viaAlias = refs.find((r) => r.alias && same(r.alias, q));
    const table = resolveTable(viaAlias ?? { table: q }, view);
    if (table) {
      columnsOf(table, viaAlias ? `${q} → ${table.table}` : table.table);
    }
    const container = view.containers.find((c) => same(c, q));
    if (container) {
      tablesOf(container, false);
    }
    return out;
  }

  if (TABLE_CLAUSES.has(ctx.clause)) {
    for (const c of view.containers) {
      tablesOf(c, c !== view.defaultContainer);
      out.push({ label: c, kind: 'schema', detail: t === 'mysql' ? 'base' : 'schéma', insertText: ident(t, c) });
    }
    return out;
  }

  for (const r of refs) {
    const target = resolveTable(r, view);
    columnsOf(target, r.alias ? `${r.alias} → ${r.table}` : r.table);
  }
  if (!ctx.clause || ctx.clause === 'SELECT') {
    for (const c of view.containers) {
      tablesOf(c, c !== view.defaultContainer);
    }
  }
  for (const k of KEYWORDS) {
    out.push({ label: k, kind: 'keyword', insertText: k });
  }
  return out;
}

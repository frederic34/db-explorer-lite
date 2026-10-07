import { DbType, QueryResult } from './types';
import { t } from './i18n';

export interface ExplainPlan {
  /** Instruction à exécuter, puis variante à essayer si la première est refusée (MariaDB : ANALYZE). */
  primary: string;
  fallback?: string;
}

const strip = (sql: string): string => sql.trim().replace(/[;\s]+$/, '');

export function explainSql(dbType: DbType, sql: string, analyze: boolean): ExplainPlan {
  const s = strip(sql);
  switch (dbType) {
    case 'postgres':
      return { primary: `EXPLAIN (FORMAT JSON${analyze ? ', ANALYZE, BUFFERS' : ''}) ${s}` };
    case 'mysql':
      return analyze ? { primary: `EXPLAIN ANALYZE ${s}`, fallback: `ANALYZE ${s}` } : { primary: `EXPLAIN ${s}` };
    default:
      return { primary: `EXPLAIN QUERY PLAN ${s}` };
  }
}

/** Le texte commence déjà par EXPLAIN / ANALYZE : on l'exécute tel quel. */
export function isExplain(sql: string): boolean {
  return /^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*(?:explain|analyze)\b/i.test(sql);
}

const NB = ' ';
const indent = (depth: number): string => (depth === 0 ? '' : NB.repeat(3 * (depth - 1)) + '└' + NB);

interface PgNode {
  [k: string]: unknown;
  Plans?: PgNode[];
}

const num = (v: unknown): string => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : '');

function pgRows(node: PgNode, depth: number, analyze: boolean, out: (string | null)[][]): void {
  const type = String(node['Node Type'] ?? '?');
  const rel = node['Relation Name'] ? ` ${t('sur', 'on')} ${node['Relation Name']}` : '';
  const idx = node['Index Name'] ? ` (${node['Index Name']})` : '';
  const notes: string[] = [];
  if (type === 'Seq Scan' && !(typeof node['Rows Removed by Filter'] === 'number' && node['Rows Removed by Filter'] === 0)) {
    notes.push(t('⚠ parcours séquentiel', '⚠ sequential scan'));
  }
  for (const k of ['Join Type', 'Index Cond', 'Hash Cond', 'Merge Cond', 'Filter', 'Sort Key', 'Group Key']) {
    const v = node[k];
    if (v !== undefined) {
      notes.push(`${k} : ${Array.isArray(v) ? v.join(', ') : String(v)}`);
    }
  }
  if (typeof node['Rows Removed by Filter'] === 'number') {
    notes.push(t(`${node['Rows Removed by Filter']} ligne(s) écartée(s) par le filtre`, `${node['Rows Removed by Filter']} row(s) removed by filter`));
  }
  const row: (string | null)[] = [
    indent(depth) + type + rel + idx,
    `${num(node['Startup Cost'])}..${num(node['Total Cost'])}`,
    num(node['Plan Rows']),
  ];
  if (analyze) {
    row.push(num(node['Actual Total Time']), num(node['Actual Rows']), num(node['Actual Loops']));
  }
  row.push(notes.join(' · '));
  out.push(row);
  for (const child of node.Plans ?? []) {
    pgRows(child, depth + 1, analyze, out);
  }
}

/** Met en forme le résultat brut d'un EXPLAIN en tableau lisible (une ligne par étape, indentée). */
export function planToResult(dbType: DbType, raw: QueryResult, analyze: boolean): QueryResult {
  const base = { rowCount: 0, truncated: false, durationMs: raw.durationMs, command: 'EXPLAIN' };
  const done = (columns: string[], rows: (string | null)[][]): QueryResult => ({ ...base, columns, rows, rowCount: rows.length });

  if (dbType === 'postgres' && raw.rows.length > 0 && typeof raw.rows[0][0] === 'string') {
    try {
      const parsed = JSON.parse(raw.rows[0][0] as string) as { Plan: PgNode; 'Planning Time'?: number; 'Execution Time'?: number }[];
      const rows: (string | null)[][] = [];
      pgRows(parsed[0].Plan, 0, analyze, rows);
      const cols = [t('Étape', 'Step'), t('Coût estimé', 'Estimated cost'), t('Lignes est.', 'Est. rows')];
      if (analyze) {
        cols.push(t('Temps (ms/boucle)', 'Time (ms/loop)'), t('Lignes réelles', 'Actual rows'), t('Boucles', 'Loops'));
      }
      cols.push(t('Détail', 'Detail'));
      if (analyze) {
        const pad = (label: string, ms: unknown) => [label, '', '', num(ms), '', '', ''];
        rows.push(pad(t('Planification (ms)', 'Planning (ms)'), parsed[0]['Planning Time']), pad(t('Exécution (ms)', 'Execution (ms)'), parsed[0]['Execution Time']));
      }
      return done(cols, rows);
    } catch {
      return raw;
    }
  }

  if (dbType === 'sqlite' && raw.columns.join() === 'id,parent,notused,detail') {
    const depth = new Map<string, number>([['0', 0]]);
    const rows = raw.rows.map((r) => {
      const d = (depth.get(String(r[1])) ?? 0) + 1;
      depth.set(String(r[0]), d);
      const detail = String(r[3] ?? '');
      const full = /^SCAN\b/i.test(detail) && !/USING\b/i.test(detail);
      return [indent(d) + detail, full ? t('⚠ parcours complet de la table', '⚠ full table scan') : ''];
    });
    return done([t('Étape', 'Step'), t('Remarque', 'Note')], rows);
  }

  // MySQL 8 : EXPLAIN ANALYZE renvoie un arbre en texte dans une seule cellule.
  if (dbType === 'mysql' && raw.columns.length === 1 && raw.rows.length > 0) {
    const lines = raw.rows.flatMap((r) => String(r[0] ?? '').split('\n')).filter((l) => l.trim() !== '');
    return done(['Plan'], lines.map((l) => [l.replace(/^ +/, (sp) => NB.repeat(sp.length))]));
  }
  return raw;
}

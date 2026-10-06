import { DbType } from './types';

/** Une instruction SQL : texte d'origine, et copie « masquée » (chaînes et commentaires neutralisés) pour l'analyse. */
export interface Statement {
  sql: string;
  masked: string;
  /** Position (dans le texte d'origine) du début de l'instruction et de son « ; » final (ou de la fin du texte). */
  from: number;
  to: number;
}

export type StatementKind = 'read' | 'session' | 'write';

export interface StatementInfo {
  sql: string;
  kind: StatementKind;
  /** Raison pour laquelle l'instruction est dangereuse (UPDATE sans WHERE, DROP…). */
  danger?: string;
  /** Modifie la structure (CREATE, ALTER, DROP, RENAME, COMMENT) : l'arbre et l'autocomplétion doivent être relus. */
  ddl: boolean;
}

const isIdentChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/**
 * Découpe un script en instructions sur les « ; » de premier niveau, en ignorant ceux des chaînes,
 * identifiants, commentaires et (PostgreSQL) chaînes entre dollars.
 */
export function parseStatements(sql: string, dbType: DbType): Statement[] {
  return scanSql(sql, dbType).statements;
}

/**
 * Analyse lexicale : instructions, et `unterminated` = le texte se termine à l'intérieur d'une chaîne,
 * d'un commentaire ou d'une chaîne entre dollars (utile pour savoir si le curseur est dans un littéral).
 */
export function scanSql(sql: string, dbType: DbType): { statements: Statement[]; unterminated: boolean } {
  const out: Statement[] = [];
  let unterminated = false;
  let segStart = 0;
  let orig = '';
  let masked = '';
  const mysql = dbType === 'mysql';
  const n = sql.length;
  let i = 0;

  const push = (end: number) => {
    if (masked.trim() !== '') {
      out.push({ sql: orig.trim(), masked: masked.trim(), from: segStart, to: end });
    }
    orig = '';
    masked = '';
    segStart = end + 1;
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    // Commentaire de ligne
    if (
      (c === '-' && next === '-' && (!mysql || next === undefined || /[\s]/.test(sql[i + 2] ?? ' '))) ||
      (mysql && c === '#')
    ) {
      let j = i;
      while (j < n && sql[j] !== '\n') {
        j++;
      }
      if (j >= n) {
        unterminated = true;
      }
      orig += sql.slice(i, j);
      masked += ' ';
      i = j;
      continue;
    }
    // Commentaire de bloc (imbriqué sous PostgreSQL)
    if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*' && !mysql) {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      if (depth > 0) {
        unterminated = true;
      }
      orig += sql.slice(i, j);
      masked += ' ';
      i = j;
      continue;
    }
    // Chaîne, identifiant entre guillemets ou apostrophes inversées
    if (c === "'" || c === '"' || (mysql && c === '`')) {
      const backslash = c !== '`' && (mysql || (c === "'" && /[eE]/.test(sql[i - 1] ?? '') && !isIdentChar(sql[i - 2])));
      let j = i + 1;
      while (j < n) {
        if (backslash && sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (j >= n) {
        unterminated = true;
      }
      j = Math.min(n, j + 1);
      orig += sql.slice(i, j);
      masked += c === "'" ? "''" : c === '"' ? '""' : 'x';
      i = j;
      continue;
    }
    // Chaîne entre dollars (PostgreSQL) : $$ … $$ ou $tag$ … $tag$
    if (!mysql && c === '$' && !isIdentChar(sql[i - 1])) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        if (close === -1) {
          unterminated = true;
        }
        const j = close === -1 ? n : close + m[0].length;
        orig += sql.slice(i, j);
        masked += "''";
        i = j;
        continue;
      }
    }
    if (c === ';') {
      push(i);
      i++;
      continue;
    }
    orig += c;
    masked += c;
    i++;
  }
  push(n);
  return { statements: out, unterminated };
}

/** Séparation en instructions (texte d'origine). */
export function splitStatements(sql: string, dbType: DbType): string[] {
  return parseStatements(sql, dbType).map((s) => s.sql);
}

const READ_FIRST = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'VALUES', 'TABLE', 'USE', 'HELP']);
const SESSION_FIRST = new Set(['SET', 'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'END', 'SAVEPOINT', 'RELEASE', 'RESET']);
const DDL_FIRST = new Set(['CREATE', 'ALTER', 'DROP', 'RENAME', 'COMMENT']);
const DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);

/** Pragmas SQLite qui ne font que lire (sans « = » ni argument qui les transformerait en réglage). */
const SAFE_PRAGMAS = new Set([
  'table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo',
  'foreign_key_list', 'foreign_key_check', 'database_list', 'compile_options', 'collation_list',
  'function_list', 'module_list', 'pragma_list', 'integrity_check', 'quick_check', 'page_count',
  'page_size', 'freelist_count', 'encoding', 'schema_version', 'user_version', 'data_version',
]);

const words = (masked: string): string[] => masked.toUpperCase().match(/[A-Z_][A-Z0-9_]*/g) ?? [];

/** Classe une instruction : lecture, session (SET, BEGIN…) ou écriture ; signale les cas dangereux. */
export function classify(st: Statement): StatementInfo {
  const w = words(st.masked);
  const first = w[0] ?? '';
  const has = (x: string) => w.includes(x);
  let kind: StatementKind;

  if (first === 'PRAGMA') {
    const name = (w[1] === 'MAIN' || w[1] === 'TEMP' ? w[2] : w[1]) ?? '';
    kind = SAFE_PRAGMAS.has(name.toLowerCase()) && !/=/.test(st.masked) ? 'read' : 'write';
  } else if (READ_FIRST.has(first)) {
    // SELECT … INTO crée une table / un fichier ; SELECT … FOR UPDATE reste une lecture.
    kind = first === 'SELECT' && has('INTO') ? 'write' : 'read';
  } else if (first === 'WITH') {
    kind = w.some((x) => DML.has(x) && !(x === 'UPDATE' && w[w.indexOf(x) - 1] === 'FOR')) ? 'write' : 'read';
  } else if (first === 'EXPLAIN') {
    kind = has('ANALYZE') && w.some((x) => DML.has(x)) ? 'write' : 'read';
  } else if (SESSION_FIRST.has(first)) {
    // SET TRANSACTION READ WRITE, SET autocommit… : peuvent lever la protection de la connexion.
    kind =
      (first === 'SET' && /read_only|read\s+write|transaction|autocommit|\brole\b|session_authorization/i.test(st.masked)) ||
      (first === 'START' && has('WRITE')) ||
      (first === 'BEGIN' && has('WRITE'))
        ? 'write'
        : 'session';
  } else {
    kind = 'write';
  }

  let danger: string | undefined;
  if (kind === 'write') {
    const dml = first === 'WITH' ? w.find((x) => x === 'UPDATE' || x === 'DELETE') : first;
    if ((dml === 'UPDATE' || dml === 'DELETE') && !has('WHERE')) {
      danger =
        dml === 'UPDATE'
          ? 'UPDATE sans WHERE : toutes les lignes de la table seront modifiées.'
          : 'DELETE sans WHERE : toutes les lignes de la table seront supprimées.';
    } else if (first === 'DROP') {
      danger = 'DROP : suppression définitive d\'un objet et de ses données.';
    } else if (first === 'TRUNCATE') {
      danger = 'TRUNCATE : toutes les lignes seront supprimées, sans retour possible.';
    } else if (first === 'ALTER' && has('DROP')) {
      danger = 'ALTER … DROP : suppression définitive d\'une colonne ou d\'une contrainte.';
    }
  }
  return { sql: st.sql, kind, danger, ddl: DDL_FIRST.has(first) };
}

export function analyze(sql: string, dbType: DbType): StatementInfo[] {
  return parseStatements(sql, dbType).map(classify);
}

export interface GuardOptions {
  readOnly?: boolean;
  production?: boolean;
  /** Confirmer UPDATE / DELETE sans WHERE, DROP, TRUNCATE… */
  confirmDangerous: boolean;
  /** Confirmer toute écriture sur une connexion de production. */
  confirmProduction: boolean;
}

export interface Assessment {
  statements: StatementInfo[];
  /** Exécution refusée (connexion en lecture seule) : message à afficher. */
  blocked?: string;
  /** Confirmation à demander avant d'exécuter. */
  confirm?: { message: string; detail: string };
}

const short = (sql: string): string => {
  const one = sql.replace(/\s+/g, ' ').trim();
  return one.length > 70 ? one.slice(0, 70) + '…' : one;
};

export function assessRun(sql: string, dbType: DbType, o: GuardOptions): Assessment {
  const statements = analyze(sql, dbType);
  const writes = statements.filter((s) => s.kind === 'write');

  if (o.readOnly && writes.length > 0) {
    return {
      statements,
      blocked: `Connexion en lecture seule : « ${short(writes[0].sql)} » est une instruction d'écriture, rien n'a été exécuté.`,
    };
  }

  const dangers = o.confirmDangerous ? statements.filter((s) => s.danger) : [];
  const prod = o.production === true && o.confirmProduction && writes.length > 0;
  if (dangers.length === 0 && !prod) {
    return { statements };
  }

  const lines: string[] = dangers.map((s) => `• ${s.danger}\n  ${short(s.sql)}`);
  if (prod && dangers.length === 0) {
    lines.push(...writes.slice(0, 5).map((s) => `• ${short(s.sql)}`));
    if (writes.length > 5) {
      lines.push(`• … et ${writes.length - 5} autre(s) instruction(s) d'écriture`);
    }
  }
  return {
    statements,
    confirm: {
      message: prod
        ? '⚠ BASE DE PRODUCTION : exécuter cette requête ?'
        : 'Cette requête est potentiellement destructrice. L\'exécuter ?',
      detail: lines.join('\n') + (prod && dangers.length > 0 ? '\n\nConnexion de production.' : ''),
    },
  };
}

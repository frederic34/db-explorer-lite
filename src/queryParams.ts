import { DbType } from './types';

export interface ParamRef {
  name: string;
  /** Position de « : » et fin du nom dans le texte d'origine. */
  start: number;
  end: number;
}

const isWord = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/**
 * Paramètres nommés `:nom` d'un texte SQL, hors chaînes, identifiants, commentaires, blocs `$$` et
 * conversions PostgreSQL (`x::int`). Un `:` précédé d'un caractère de mot (`a[1:2]`, `12:30`) n'en est pas un.
 */
export function findParams(sql: string, dbType: DbType): ParamRef[] {
  const out: ParamRef[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') { i++; }
    } else if (c === '#' && dbType === 'mysql') {
      while (i < n && sql[i] !== '\n') { i++; }
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < n) {
        if (sql[i] === '\\' && dbType === 'mysql' && c !== '`') {
          i += 2;
        } else if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; } else { i++; break; }
        } else {
          i++;
        }
      }
    } else if (c === '$' && dbType === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m && !isWord(sql[i - 1])) {
        const end = sql.indexOf(m[0], i + m[0].length);
        i = end < 0 ? n : end + m[0].length;
      } else {
        i++;
      }
    } else if (c === ':') {
      if (next === ':') {
        i += 2;
      } else if (next !== undefined && /[A-Za-z_]/.test(next) && !isWord(sql[i - 1])) {
        let j = i + 1;
        while (j < n && isWord(sql[j]) && sql[j] !== '$') { j++; }
        out.push({ name: sql.slice(i + 1, j), start: i, end: j });
        i = j;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return out;
}

/** Noms distincts, dans l'ordre d'apparition. */
export function paramNames(sql: string, dbType: DbType): string[] {
  return [...new Set(findParams(sql, dbType).map((p) => p.name))];
}

/** Valeur saisie → littéral SQL : nombre tel quel, `null`, sinon chaîne entre apostrophes. */
export function paramLiteral(value: string, dbType: DbType): string {
  const v = value.trim();
  if (/^null$/i.test(v)) {
    return 'NULL';
  }
  if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(v)) {
    return v;
  }
  let s = value.replace(/'/g, "''");
  if (dbType === 'mysql') {
    s = s.replace(/\\/g, '\\\\');
  }
  return `'${s}'`;
}

export function substituteParams(sql: string, dbType: DbType, values: Record<string, string>): string {
  let out = '';
  let last = 0;
  for (const p of findParams(sql, dbType)) {
    out += sql.slice(last, p.start) + paramLiteral(values[p.name] ?? '', dbType);
    last = p.end;
  }
  return out + sql.slice(last);
}

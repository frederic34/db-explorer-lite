import { BrowseQuery, buildCountQuery, buildPageQuery } from './browse';
import { isBinaryLike } from './editing';
import { DbDriver, DbType } from './types';
import { quoteIdent } from './util';

export type ExportFormat = 'csv' | 'json' | 'sql';
type Row = (string | null)[];

export interface ExportColumn {
  name: string;
  /** Type SQL de la colonne si on le connaît (aperçu de table) : permet des nombres JSON / SQL non quotés. */
  type?: string;
}

export interface ExportOptions {
  format: ExportFormat;
  columns: ExportColumn[];
  /** Séparateur CSV (« , », « ; » ou tabulation). */
  csvSeparator?: string;
  /** INSERT SQL : dialecte et nom de table déjà qualifié et quoté. */
  dbType?: DbType;
  table?: string;
}

export const EXTENSIONS: Record<ExportFormat, string> = { csv: 'csv', json: 'json', sql: 'sql' };

const NUMERIC_TYPE =
  /^(tiny|small|medium|big)?int(eger)?\b|^int\d|^serial|^bigserial|^smallserial|^decimal|^numeric|^number|^float|^double|^real|^money\b/i;

const isNumericType = (t?: string): boolean => !!t && NUMERIC_TYPE.test(t.trim());
const isBooleanType = (t?: string): boolean => !!t && /^bool(ean)?$/i.test(t.trim());
const isArrayType = (t?: string): boolean => !!t && (/^ARRAY$/i.test(t.trim()) || /\[\]$/.test(t.trim()));
const isJsonType = (t?: string): boolean => !!t && /^jsonb?$/i.test(t.trim());

/** Nombre représentable sans perte dans un nombre JSON / SQL (entier sûr, ou ≤ 15 chiffres significatifs). */
function plainNumber(v: string): boolean {
  if (/^-?\d+$/.test(v)) {
    return Number.isSafeInteger(Number(v));
  }
  if (/^-?\d+\.\d+$/.test(v)) {
    return v.replace(/[-.]/g, '').replace(/^0+/, '').length <= 15;
  }
  return false;
}

export function jsonValue(v: string | null, type?: string): unknown {
  if (v === null) {
    return null;
  }
  if (isNumericType(type) && plainNumber(v)) {
    return Number(v);
  }
  if (isBooleanType(type) && (v === 'true' || v === 'false')) {
    return v === 'true';
  }
  if (isJsonType(type) || isArrayType(type)) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/** Les tableaux PostgreSQL sont affichés en JSON ; on les réécrit en littéral de tableau (`{"a","b"}`). */
function pgArrayLiteral(v: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const item = (x: unknown): string =>
    x === null ? 'NULL' : Array.isArray(x) ? `{${x.map(item).join(',')}}` : `"${String(typeof x === 'object' ? JSON.stringify(x) : x).replace(/[\\"]/g, '\\$&')}"`;
  return `{${parsed.map(item).join(',')}}`;
}

export function csvCell(v: string | null, sep: string): string {
  if (v === null) {
    return '';
  }
  return v.includes(sep) || /["\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const TRUNCATED_BINARY = /^<binaire \d+ octets>$/;

/**
 * Littéral SQL d'une cellule. `lost` est incrémenté quand la valeur ne peut pas être restituée
 * (binaire tronqué à l'affichage) : elle est alors remplacée par NULL.
 */
export function sqlLiteral(v: string | null, col: ExportColumn, dbType: DbType, lost?: { n: number }): string {
  if (v === null) {
    return 'NULL';
  }
  if (isNumericType(col.type) && plainNumber(v)) {
    return v;
  }
  if (dbType === 'postgres' && isBooleanType(col.type) && (v === 'true' || v === 'false')) {
    return v.toUpperCase();
  }
  if (dbType === 'postgres' && isArrayType(col.type)) {
    const lit = pgArrayLiteral(v);
    if (lit !== undefined) {
      return `'${lit.replace(/'/g, "''")}'`;
    }
  }
  if (col.type && isBinaryLike(dbType, col.type)) {
    if (TRUNCATED_BINARY.test(v)) {
      if (lost) {
        lost.n++;
      }
      return 'NULL';
    }
    const hex = /^0x([0-9a-f]*)$/i.exec(v);
    if (hex) {
      return dbType === 'postgres' ? `'\\x${hex[1]}'` : dbType === 'sqlite' ? `X'${hex[1]}'` : hex[1] ? `0x${hex[1]}` : "''";
    }
  }
  let s = v.replace(/'/g, "''");
  if (dbType === 'mysql') {
    s = s.replace(/\\/g, '\\\\').replace(/\0/g, '\\0');
  }
  return `'${s}'`;
}

/**
 * Écrit un jeu de lignes dans un format, par lots (adapté à un export en continu de grosses tables) :
 * begin() → rows() autant de fois que nécessaire → end().
 */
export class RowFormatter {
  /** Valeurs binaires tronquées à l'affichage, remplacées par NULL dans un export SQL. */
  readonly lost = { n: 0 };
  private count = 0;
  private readonly sep: string;

  constructor(
    private readonly o: ExportOptions,
    private readonly write: (chunk: string) => void | Promise<void>,
  ) {
    this.sep = o.csvSeparator ?? ',';
    if (o.format === 'sql' && (!o.dbType || !o.table)) {
      throw new Error("L'export en INSERT SQL nécessite le type de base et le nom de la table.");
    }
  }

  async begin(): Promise<void> {
    const names = this.o.columns.map((c) => c.name);
    if (this.o.format === 'csv') {
      // BOM UTF-8 : Excel détecte ainsi correctement les accents.
      await this.write('﻿' + names.map((n) => csvCell(n, this.sep)).join(this.sep) + '\r\n');
    } else if (this.o.format === 'json') {
      await this.write('[');
    }
  }

  async rows(rows: Row[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const cols = this.o.columns;
    let out = '';
    if (this.o.format === 'csv') {
      out = rows.map((r) => r.map((v) => csvCell(v, this.sep)).join(this.sep) + '\r\n').join('');
    } else if (this.o.format === 'json') {
      for (const r of rows) {
        const obj: Record<string, unknown> = {};
        cols.forEach((c, i) => {
          obj[c.name] = jsonValue(r[i], c.type);
        });
        out += (this.count === 0 ? '\n  ' : ',\n  ') + JSON.stringify(obj);
        this.count++;
      }
    } else {
      const dbType = this.o.dbType as DbType;
      const head = `INSERT INTO ${this.o.table} (${cols.map((c) => quoteIdent(dbType, c.name)).join(', ')}) VALUES\n`;
      for (let i = 0; i < rows.length; i += 100) {
        const tuples = rows
          .slice(i, i + 100)
          .map((r) => '  (' + r.map((v, j) => sqlLiteral(v, cols[j], dbType, this.lost)).join(', ') + ')');
        out += head + tuples.join(',\n') + ';\n';
      }
    }
    await this.write(out);
  }

  async end(): Promise<void> {
    if (this.o.format === 'json') {
      await this.write(this.count > 0 ? '\n]\n' : ']\n');
    }
  }
}

/** Tout en une fois (lignes déjà en mémoire). */
export async function formatRows(o: ExportOptions, rows: Row[]): Promise<{ text: string; lost: number }> {
  let text = '';
  const f = new RowFormatter(o, (c) => {
    text += c;
  });
  await f.begin();
  await f.rows(rows);
  await f.end();
  return { text, lost: f.lost.n };
}

export interface StreamArgs {
  driver: DbDriver;
  /** Requête de l'aperçu (tri, filtre et égalité compris) ; `offset` et `pageSize` sont ignorés. */
  query: Omit<BrowseQuery, 'offset' | 'pageSize'>;
  batch: number;
  onBatch: (rows: Row[]) => Promise<void>;
  isCancelled: () => boolean;
  /** Appelé après chaque lot : lignes écrites, total si connu. */
  onProgress?: (done: number, total?: number) => void;
}

/**
 * Lit toute la table (avec le tri et les filtres de l'aperçu) par lots successifs : la mémoire reste
 * bornée quelle que soit la taille de la table. Retourne le nombre de lignes lues.
 */
export async function streamTable(a: StreamArgs): Promise<number> {
  let total: number | undefined;
  try {
    const c = buildCountQuery({ ...a.query, offset: 0, pageSize: 1 });
    total = Number((await a.driver.query(c.sql, c.params)).rows[0]?.[0]);
    if (!Number.isFinite(total)) {
      total = undefined;
    }
  } catch {
    total = undefined;
  }
  let offset = 0;
  for (;;) {
    if (a.isCancelled()) {
      return offset;
    }
    const q = buildPageQuery({ ...a.query, offset, pageSize: a.batch });
    const res = await a.driver.query(q.sql, q.params);
    const rows = res.rows.slice(0, a.batch);
    await a.onBatch(rows);
    offset += rows.length;
    a.onProgress?.(offset, total);
    if (res.rows.length <= a.batch) {
      return offset;
    }
  }
}

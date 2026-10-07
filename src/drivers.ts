import * as fs from 'fs';
import * as path from 'path';
import * as mysql from 'mysql2/promise';
import { Worker } from 'worker_threads';
import { Pool, types as pgTypes } from 'pg';
import {
  ColumnInfo,
  Referrer,
  ConnectionConfig,
  ConstraintInfo,
  DbDriver,
  IndexInfo,
  DriverOptions,
  QueryResult,
  StructureColumn,
  TableInfo,
  TableStructure,
  WriteStatement,
} from './types';
import { RawSet, SQLITE_MAX_BYTES, WorkerData, WorkerRequest, WorkerResponse } from './sqliteShared';
import { CancelToken, quoteIdent, repeatUntilDone } from './util';
import { isFrench, t } from './i18n';

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

function mismatch(actual: number, expected: number): Error {
  return new Error(
    t(
      `Opération annulée : ${actual} ligne(s) affectée(s) au lieu de ${expected} attendue(s). ` +
        'Les données ont peut-être été modifiées entre-temps ; actualisez l\'aperçu.',
      `Operation cancelled: ${actual} row(s) affected instead of the expected ${expected}. ` +
        'The data may have been modified in the meantime; refresh the preview.',
    ),
  );
}

const MYSQL_SYSTEM_DBS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);

/** Convertit une valeur renvoyée par un pilote en texte affichable (null = NULL SQL). */
export function formatCell(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return value.length <= 32 ? '0x' + value.toString('hex') : `<BLOB ${value.length} B>`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildResult(
  columns: string[],
  all: unknown[][],
  maxRows: number,
  durationMs: number,
): QueryResult {
  const truncated = all.length > maxRows;
  const kept = truncated ? all.slice(0, maxRows) : all;
  return {
    columns,
    rows: kept.map((row) => row.map(formatCell)),
    rowCount: all.length,
    truncated,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// MySQL / MariaDB
// ---------------------------------------------------------------------------

export class MySqlDriver implements DbDriver {
  readonly type = 'mysql' as const;
  private readonly pool: mysql.Pool;

  constructor(
    private readonly cfg: ConnectionConfig,
    password: string,
    private readonly opts: DriverOptions,
    tlsServername?: string,
  ) {
    this.pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password,
      database: cfg.database || undefined,
      ssl: cfg.ssl ? ((tlsServername ? { servername: tlsServername } : {}) as mysql.SslOptions) : undefined,
      connectTimeout: 10000,
      connectionLimit: 3,
      // affectedRows = lignes trouvées (et non seulement modifiées) : un UPDATE qui réécrit
      // la même valeur doit compter comme une ligne affectée.
      flags: ['+FOUND_ROWS'],
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    if (cfg.readOnly) {
      // Garde-fou côté serveur : toute écriture échoue, quelle que soit l'origine de la requête.
      this.pool.pool.on('connection', (conn) => {
        conn.query('SET SESSION TRANSACTION READ ONLY', () => undefined);
      });
    }
  }

  private async run(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: unknown; fields: mysql.FieldPacket[] | undefined }> {
    const options = { sql, values, rowsAsArray: true } as mysql.QueryOptions;
    const [rows, fields] = (await this.pool.query(options)) as unknown as [
      unknown,
      mysql.FieldPacket[] | undefined,
    ];
    return { rows, fields };
  }

  async listContainers(): Promise<string[]> {
    if (this.cfg.database) {
      return [this.cfg.database];
    }
    const { rows } = await this.run(
      'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
    );
    const names = (rows as unknown[][]).map((r) => String(r[0]));
    return this.opts.showSystem()
      ? names
      : names.filter((n) => !MYSQL_SYSTEM_DBS.has(n.toLowerCase()));
  }

  async listTables(container: string): Promise<TableInfo[]> {
    const { rows } = await this.run(
      'SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [container],
    );
    return (rows as unknown[][]).map((r) => ({
      name: String(r[0]),
      isView: String(r[1]).includes('VIEW'),
    }));
  }

  async describeTable(container: string, table: string): Promise<TableStructure> {
    const q = (n: string) => quoteIdent('mysql', n);
    const cols = (
      await this.run(
        'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT ' +
          'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
        [container, table],
      )
    ).rows as unknown[][];
    const columns: StructureColumn[] = cols.map((r) => {
      const nullable = String(r[2]).toUpperCase() === 'YES';
      const def = r[4] === null || (nullable && String(r[4]).toUpperCase() === 'NULL') ? null : String(r[4]);
      return {
        name: String(r[0]),
        type: String(r[1]),
        nullable,
        primaryKey: String(r[3]).toUpperCase() === 'PRI',
        default: def,
        extra: String(r[5] ?? '') || undefined,
        comment: String(r[6] ?? '') || undefined,
      };
    });

    const idx = new Map<string, IndexInfo>();
    const stats = (
      await this.run(
        'SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE, SUB_PART FROM information_schema.STATISTICS ' +
          'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
        [container, table],
      )
    ).rows as unknown[][];
    for (const r of stats) {
      const name = String(r[0]);
      const entry = idx.get(name) ?? {
        name,
        columns: [],
        unique: Number(r[1]) === 0,
        primary: name === 'PRIMARY',
        method: String(r[3] ?? '') || undefined,
      };
      entry.columns.push(r[2] === null ? '(expression)' : String(r[2]) + (r[4] ? `(${r[4]})` : ''));
      idx.set(name, entry);
    }
    const indexes = [...idx.values()].sort((a, b) => Number(b.primary) - Number(a.primary));

    const constraints: ConstraintInfo[] = [];
    try {
      const tcs = (
        await this.run(
          'SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE FROM information_schema.TABLE_CONSTRAINTS ' +
            'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY FIELD(CONSTRAINT_TYPE, \'PRIMARY KEY\', \'UNIQUE\', \'FOREIGN KEY\', \'CHECK\'), CONSTRAINT_NAME',
          [container, table],
        )
      ).rows as unknown[][];
      const kcu = (
        await this.run(
          'SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME ' +
            'FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION',
          [container, table],
        )
      ).rows as unknown[][];
      const rules = new Map<string, string>();
      for (const r of (
        await this.run(
          'SELECT CONSTRAINT_NAME, UPDATE_RULE, DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS ' +
            'WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?',
          [container, table],
        )
      ).rows as unknown[][]) {
        const parts = [
          String(r[1]) !== 'RESTRICT' && String(r[1]) !== 'NO ACTION' ? ` ON UPDATE ${r[1]}` : '',
          String(r[2]) !== 'RESTRICT' && String(r[2]) !== 'NO ACTION' ? ` ON DELETE ${r[2]}` : '',
        ];
        rules.set(String(r[0]), parts.join(''));
      }
      let checks = new Map<string, string>();
      try {
        const ck = (
          await this.run(
            'SELECT tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE FROM information_schema.TABLE_CONSTRAINTS tc ' +
              'JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME ' +
              "WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'",
            [container, table],
          )
        ).rows as unknown[][];
        checks = new Map(ck.map((r) => [String(r[0]), String(r[1])]));
      } catch {
        // Serveur sans CHECK_CONSTRAINTS (MySQL < 8.0.16).
      }
      for (const r of tcs) {
        const name = String(r[0]);
        const kind = String(r[1]) as ConstraintInfo['kind'];
        const rows = kcu.filter((k) => String(k[0]) === name);
        const own = rows.map((k) => q(String(k[1]))).join(', ');
        let definition = '';
        if (kind === 'FOREIGN KEY') {
          const target = rows[0];
          definition =
            `(${own}) REFERENCES ${q(String(target?.[2] ?? ''))}.${q(String(target?.[3] ?? ''))} ` +
            `(${rows.map((k) => q(String(k[4]))).join(', ')})${rules.get(name) ?? ''}`;
        } else if (kind === 'CHECK') {
          definition = checks.get(name) ?? '';
        } else {
          definition = `(${own})`;
        }
        constraints.push({ name, kind, definition });
      }
    } catch {
      // Droits insuffisants : seules les colonnes et les index sont affichés.
    }

    const created = (await this.run(`SHOW CREATE TABLE ${q(container)}.${q(table)}`)).rows as unknown[][];
    const ddl = String(created[0]?.[1] ?? '');
    return { isView: /^CREATE\b[^]*?\bVIEW\b/i.test(ddl.slice(0, 200)), columns, indexes, constraints, ddl: ddl + ';' };
  }

  async listReferrers(container: string, table: string): Promise<Referrer[]> {
    const { rows } = await this.run(
      'SELECT k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME, k.REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE k ' +
        'WHERE k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ? ' +
        'AND (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE k2 WHERE k2.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA ' +
        'AND k2.TABLE_NAME = k.TABLE_NAME AND k2.CONSTRAINT_NAME = k.CONSTRAINT_NAME) = 1 ' +
        'ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME',
      [container, table],
    );
    return (rows as unknown[][]).map((r) => ({
      container: String(r[0]), table: String(r[1]), column: String(r[2]), refColumn: String(r[3]),
    }));
  }

  async listColumns(container: string, table: string): Promise<ColumnInfo[]> {
    const { rows } = await this.run(
      'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS ' +
        'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [container, table],
    );
    const refs = new Map<string, { container: string; table: string; column: string }>();
    try {
      // Clés étrangères sur une seule colonne (les clés composites ne sont pas suivies).
      const fk = await this.run(
        'SELECT k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME ' +
          'FROM information_schema.KEY_COLUMN_USAGE k ' +
          'WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ' +
          'AND (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE k2 WHERE k2.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA ' +
          'AND k2.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND k2.TABLE_NAME = k.TABLE_NAME) = 1',
        [container, table],
      );
      for (const r of fk.rows as unknown[][]) {
        refs.set(String(r[0]), { container: String(r[1]), table: String(r[2]), column: String(r[3]) });
      }
    } catch {
      // Droits insuffisants sur information_schema : on n'affiche simplement pas les liens.
    }
    return (rows as unknown[][]).map((r) => {
      const nullable = String(r[2]).toUpperCase() === 'YES';
      const extra = String(r[5] ?? '');
      const generated = /\b(VIRTUAL|STORED) GENERATED\b|\bPERSISTENT\b/i.test(extra);
      // MariaDB renvoie la chaîne « NULL » pour DEFAULT NULL : ce n'est pas une vraie valeur par défaut.
      const realDefault = r[4] !== null && !(nullable && String(r[4]).toUpperCase() === 'NULL');
      return {
        name: String(r[0]),
        type: String(r[1]),
        nullable,
        primaryKey: String(r[3]).toUpperCase() === 'PRI',
        hasDefault: realDefault || /auto_increment/i.test(extra) || generated,
        generated,
        references: refs.get(String(r[0])),
      };
    });
  }

  async insertRow(sql: string, params: unknown[]): Promise<{ row?: (string | null)[]; insertId?: string }> {
    const [res] = (await this.pool.query({ sql, values: params } as mysql.QueryOptions)) as unknown as [
      { insertId?: number | string },
      unknown,
    ];
    const id = res?.insertId;
    return { insertId: id !== undefined && String(id) !== '0' ? String(id) : undefined };
  }

  async executeBatch(statements: WriteStatement[]): Promise<number[]> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const affected: number[] = [];
      for (const st of statements) {
        const [res] = (await conn.query({ sql: st.sql, values: st.params } as mysql.QueryOptions)) as unknown as [
          { affectedRows?: number },
          unknown,
        ];
        const n = res?.affectedRows ?? 0;
        if (st.expect !== undefined && n !== st.expect) {
          throw mismatch(n, st.expect);
        }
        affected.push(n);
      }
      await conn.commit();
      return affected;
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      throw err;
    } finally {
      conn.release();
    }
  }

  private toResult(rows: unknown, fields: mysql.FieldPacket[] | undefined, durationMs: number): QueryResult {
    if (Array.isArray(rows) && fields) {
      return buildResult(
        fields.map((f) => f.name),
        rows as unknown[][],
        this.opts.maxRows(),
        durationMs,
      );
    }
    const header = rows as { affectedRows?: number };
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: header?.affectedRows ?? 0,
      truncated: false,
      durationMs,
    };
  }

  /** Interrompt la requête en cours sur la connexion `threadId` (KILL QUERY, depuis une autre connexion). */
  private killer(threadId: number, isDone: () => boolean): () => Promise<void> {
    return async () => repeatUntilDone(() => this.pool.query(`KILL QUERY ${Number(threadId)}`), isDone)
  }

  async query(sql: string, params?: unknown[], cancel?: CancelToken): Promise<QueryResult> {
    const t0 = Date.now();
    if (!cancel) {
      const { rows, fields } = await this.run(sql, params);
      return this.toResult(rows, fields, Date.now() - t0);
    }
    const conn = await this.pool.getConnection();
    let done = false;
    if (cancel.requested) {
      conn.release();
      throw new Error(t('Requête annulée.', 'Query cancelled.'));
    }
    cancel.attach(this.killer(conn.threadId, () => done));
    try {
      const [rows, fields] = (await conn.query({ sql, values: params, rowsAsArray: true } as mysql.QueryOptions)) as unknown as [
        unknown,
        mysql.FieldPacket[] | undefined,
      ];
      return this.toResult(rows, fields, Date.now() - t0);
    } finally {
      done = true;
      cancel.detach();
      conn.release();
    }
  }

  async script(statements: string[], cancel?: CancelToken): Promise<QueryResult> {
    const t0 = Date.now();
    const conn = await this.pool.getConnection();
    let done = false;
    if (cancel?.requested) {
      conn.release();
      throw new Error(t('Requête annulée.', 'Query cancelled.'));
    }
    cancel?.attach(this.killer(conn.threadId, () => done));
    let last: QueryResult | undefined;
    const all: QueryResult[] = [];
    let index = 0;
    try {
      for (const sql of statements) {
        index++;
        if (cancel?.requested) {
          throw new Error(t('Requête annulée.', 'Query cancelled.'));
        }
        const s0 = Date.now();
        const [rows, fields] = (await conn.query({ sql, rowsAsArray: true } as mysql.QueryOptions)) as unknown as [
          unknown,
          mysql.FieldPacket[] | undefined,
        ];
        last = this.toResult(rows, fields, Date.now() - s0);
        all.push(last);
      }
    } catch (err) {
      if (statements.length > 1 && !cancel?.requested) {
        const e = err as Error;
        e.message = t(`Instruction ${index}/${statements.length} : ${e.message}`, `Statement ${index}/${statements.length}: ${e.message}`) +
          (index > 1
            ? t(`\n(les ${index - 1} instruction(s) précédente(s) ont déjà été exécutées)`, `\n(the ${index - 1} previous statement(s) have already been executed)`)
            : '');
      }
      throw err;
    } finally {
      done = true;
      cancel?.detach();
      conn.release();
    }
    return {
      ...(last as QueryResult),
      durationMs: Date.now() - t0,
      statements: statements.length,
      sets: all.length > 1 ? all : undefined,
    };
  }

  async dispose(): Promise<void> {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

/** date, time, timestamp, timestamptz, interval, timetz, json, jsonb : on garde le texte renvoyé par le serveur (un JSON.parse perdrait la précision des grands nombres). */
const PG_RAW_TEXT_OIDS = new Set([1082, 1083, 1114, 1184, 1186, 1266, 114, 3802]);

export class PostgresDriver implements DbDriver {
  readonly type = 'postgres' as const;
  private readonly pool: Pool;

  constructor(
    cfg: ConnectionConfig,
    password: string,
    private readonly opts: DriverOptions,
    tlsServername?: string,
  ) {
    this.pool = new Pool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password,
      database: cfg.database || 'postgres',
      ssl: cfg.ssl ? (tlsServername ? { servername: tlsServername } : true) : undefined,
      connectionTimeoutMillis: 10000,
      max: 3,
      options: cfg.readOnly ? '-c default_transaction_read_only=on' : undefined,
      types: {
        getTypeParser: (oid: number, format?: string) =>
          PG_RAW_TEXT_OIDS.has(oid)
            ? (value: string) => value
            : pgTypes.getTypeParser(oid, format as 'text'),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // Évite qu'une coupure sur une connexion inactive ne fasse planter l'hôte d'extensions.
    this.pool.on('error', () => undefined);
  }

  private async rows(text: string, values: unknown[] = []): Promise<unknown[][]> {
    const res = await this.pool.query({ text, values, rowMode: 'array' });
    return res.rows as unknown[][];
  }

  async listContainers(): Promise<string[]> {
    const sql = this.opts.showSystem()
      ? 'SELECT schema_name FROM information_schema.schemata ORDER BY schema_name'
      : "SELECT schema_name FROM information_schema.schemata WHERE schema_name <> 'information_schema' AND schema_name NOT LIKE 'pg\\_%' ORDER BY schema_name";
    return (await this.rows(sql, [])).map((r) => String(r[0]));
  }

  async listTables(container: string): Promise<TableInfo[]> {
    const rows = await this.rows(
      'SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
        "WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname",
      [container],
    );
    return rows.map((r) => ({
      name: String(r[0]),
      isView: r[1] === 'v' || r[1] === 'm',
    }));
  }

  async describeTable(container: string, table: string): Promise<TableStructure> {
    const q = (n: string) => quoteIdent('postgres', n);
    const OID =
      '(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2)';
    const kind = await this.rows(
      'SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2',
      [container, table],
    );
    if (kind.length === 0) {
      throw new Error(t(`Table ou vue introuvable : ${container}.${table}`, `Table or view not found: ${container}.${table}`));
    }
    const relkind = String(kind[0][0]);
    const isView = relkind === 'v' || relkind === 'm';

    const colRows = await this.rows(
      'SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid), ' +
        "a.attidentity, " +
        (await this.hasGenerated() ? 'a.attgenerated' : "''") +
        ', col_description(a.attrelid, a.attnum) FROM pg_attribute a ' +
        'LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum ' +
        `WHERE a.attrelid = ${OID} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [container, table],
    );
    const conRows = await this.rows(
      `SELECT conname, contype, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = ${OID} ORDER BY contype = 'p' DESC, contype = 'u' DESC, contype = 'f' DESC, conname`,
      [container, table],
    );
    const pkCols = new Set<string>();
    const KINDS: Record<string, ConstraintInfo['kind']> = {
      p: 'PRIMARY KEY', u: 'UNIQUE', f: 'FOREIGN KEY', c: 'CHECK', x: 'EXCLUDE',
    };
    const constraints: ConstraintInfo[] = [];
    for (const r of conRows) {
      const k = KINDS[String(r[1])];
      if (!k) {
        continue; // contraintes de domaine / déclencheurs de contrainte : hors sujet ici
      }
      const def = String(r[2]);
      constraints.push({ name: String(r[0]), kind: k, definition: def.replace(/^(PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|EXCLUDE)\s*/i, '') });
      if (k === 'PRIMARY KEY') {
        for (const c of def.slice(def.indexOf('(') + 1, def.lastIndexOf(')')).split(',')) {
          pkCols.add(c.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
        }
      }
    }
    const columns: StructureColumn[] = colRows.map((r) => {
      const identity = String(r[4]);
      const generated = String(r[5]) === 's';
      const extra =
        identity === 'a' ? 'GENERATED ALWAYS AS IDENTITY'
        : identity === 'd' ? 'GENERATED BY DEFAULT AS IDENTITY'
        : generated ? 'GENERATED ALWAYS AS (…) STORED'
        : undefined;
      return {
        name: String(r[0]),
        type: String(r[1]),
        nullable: r[2] !== true,
        primaryKey: pkCols.has(String(r[0])),
        default: r[3] === null || identity !== '' ? (generated && r[3] !== null ? String(r[3]) : null) : String(r[3]),
        extra,
        comment: r[6] === null ? undefined : String(r[6]),
      };
    });

    const idxRows = await this.rows(
      'SELECT i.relname, ix.indisunique, ix.indisprimary, am.amname, pg_get_indexdef(ix.indexrelid), ' +
        'ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true) FROM generate_series(0, ix.indnatts - 1) k) ' +
        'FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_am am ON am.oid = i.relam ' +
        `WHERE ix.indrelid = ${OID} ORDER BY ix.indisprimary DESC, i.relname`,
      [container, table],
    );
    const indexes: IndexInfo[] = idxRows.map((r) => ({
      name: String(r[0]),
      unique: r[1] === true,
      primary: r[2] === true,
      method: String(r[3]),
      columns: (r[5] as string[]) ?? [],
    }));

    let ddl: string;
    if (isView) {
      const def = await this.rows(`SELECT pg_get_viewdef(${OID}, true)`, [container, table]);
      ddl = `CREATE ${relkind === 'm' ? 'MATERIALIZED VIEW' : 'OR REPLACE VIEW'} ${q(container)}.${q(table)} AS\n${String(def[0]?.[0] ?? '').trim()}` +
        (String(def[0]?.[0] ?? '').trim().endsWith(';') ? '' : ';');
    } else {
      const lines = columns.map((c) => {
        let line = `  ${q(c.name)} ${c.type}`;
        if (c.extra?.startsWith('GENERATED') && c.extra.includes('STORED')) {
          line += ` GENERATED ALWAYS AS (${c.default ?? ''}) STORED`;
        } else if (c.extra) {
          line += ` ${c.extra}`;
        } else if (c.default !== null) {
          line += ` DEFAULT ${c.default}`;
        }
        return c.nullable ? line : line + ' NOT NULL';
      });
      for (const k of constraints) {
        lines.push(`  CONSTRAINT ${q(k.name)} ${k.kind} ${k.definition}`);
      }
      const owned = new Set(constraints.map((k) => k.name));
      const extraIdx = idxRows.filter((r) => !owned.has(String(r[0]))).map((r) => `${String(r[4])};`);
      ddl = `CREATE TABLE ${q(container)}.${q(table)} (\n${lines.join(',\n')}\n);` + (extraIdx.length ? '\n\n' + extraIdx.join('\n') : '');
    }
    return { isView, columns, indexes, constraints, ddl };
  }

  private generatedColumn?: boolean;
  /** pg_attribute.attgenerated n'existe qu'à partir de PostgreSQL 12. */
  private async hasGenerated(): Promise<boolean> {
    if (this.generatedColumn === undefined) {
      const r = await this.rows(
        "SELECT 1 FROM pg_attribute WHERE attrelid = 'pg_attribute'::regclass AND attname = 'attgenerated'",
      );
      this.generatedColumn = r.length > 0;
    }
    return this.generatedColumn;
  }

  async listReferrers(container: string, table: string): Promise<Referrer[]> {
    const rows = await this.rows(
      'SELECT n.nspname, c.relname, a.attname, ra.attname FROM pg_constraint k ' +
        'JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace ' +
        'JOIN pg_class rc ON rc.oid = k.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace ' +
        'JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1] ' +
        'JOIN pg_attribute ra ON ra.attrelid = k.confrelid AND ra.attnum = k.confkey[1] ' +
        "WHERE k.contype = 'f' AND array_length(k.conkey, 1) = 1 AND rn.nspname = $1 AND rc.relname = $2 " +
        'ORDER BY 1, 2, 3',
      [container, table],
    );
    return rows.map((r) => ({ container: String(r[0]), table: String(r[1]), column: String(r[2]), refColumn: String(r[3]) }));
  }

  async listColumns(container: string, table: string): Promise<ColumnInfo[]> {
    const rows = await this.rows(
      'SELECT c.column_name, c.data_type, c.is_nullable, ' +
        'EXISTS (SELECT 1 FROM information_schema.table_constraints tc ' +
        '  JOIN information_schema.key_column_usage k ' +
        '    ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema AND k.table_name = tc.table_name ' +
        "  WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema " +
        '    AND tc.table_name = c.table_name AND k.column_name = c.column_name) AS is_pk ' +
        ', c.column_default, c.is_identity, c.identity_generation, c.is_generated ' +
        'FROM information_schema.columns c WHERE c.table_schema = $1 AND c.table_name = $2 ORDER BY c.ordinal_position',
      [container, table],
    );
    const refs = new Map<string, { container: string; table: string; column: string }>();
    try {
      const fk = await this.rows(
        'SELECT a.attname, nf.nspname, cf.relname, af.attname FROM pg_constraint con ' +
          'JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace ' +
          'JOIN pg_class cf ON cf.oid = con.confrelid JOIN pg_namespace nf ON nf.oid = cf.relnamespace ' +
          'JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1] ' +
          'JOIN pg_attribute af ON af.attrelid = con.confrelid AND af.attnum = con.confkey[1] ' +
          "WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1 AND n.nspname = $1 AND c.relname = $2",
        [container, table],
      );
      for (const r of fk) {
        refs.set(String(r[0]), { container: String(r[1]), table: String(r[2]), column: String(r[3]) });
      }
    } catch {
      // Droits insuffisants : pas de liens.
    }
    return rows.map((r) => {
      const generated = r[7] === 'ALWAYS' || (r[5] === 'YES' && r[6] === 'ALWAYS');
      return {
        name: String(r[0]),
        type: String(r[1]),
        nullable: String(r[2]).toUpperCase() === 'YES',
        primaryKey: r[3] === true,
        hasDefault: r[4] !== null || r[5] === 'YES' || generated,
        generated,
        references: refs.get(String(r[0])),
      };
    });
  }

  async insertRow(sql: string, params: unknown[]): Promise<{ row?: (string | null)[]; insertId?: string }> {
    const res = await this.pool.query({ text: sql, values: params, rowMode: 'array' });
    const first = res.rows[0] as unknown[] | undefined;
    return { row: first ? first.map(formatCell) : undefined };
  }

  async executeBatch(statements: WriteStatement[]): Promise<number[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const affected: number[] = [];
      for (const st of statements) {
        const res = await client.query(st.sql, st.params);
        const n = res.rowCount ?? 0;
        if (st.expect !== undefined && n !== st.expect) {
          throw mismatch(n, st.expect);
        }
        affected.push(n);
      }
      await client.query('COMMIT');
      return affected;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async query(sql: string, params?: unknown[], cancel?: CancelToken): Promise<QueryResult> {
    const t0 = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let raw: any;
    if (!cancel) {
      raw = await this.pool.query({ text: sql, values: params, rowMode: 'array' });
    } else {
      const client = await this.pool.connect();
      const pid = (client as unknown as { processID: number }).processID;
      let done = false;
      if (cancel.requested) {
        client.release();
        throw new Error(t('Requête annulée.', 'Query cancelled.'));
      }
      cancel.attach(async () =>
        repeatUntilDone(() => this.pool.query('SELECT pg_cancel_backend($1)', [pid]), () => done),
      );
      try {
        raw = await client.query({ text: sql, values: params, rowMode: 'array' });
      } finally {
        done = true;
        cancel.detach();
        client.release();
      }
    }
    const durationMs = Date.now() - t0;
    // Plusieurs instructions dans le texte : pg renvoie un tableau ; le résultat principal est le dernier.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const convert = (res: any, ms: number): QueryResult =>
      res.fields && res.fields.length > 0
        ? buildResult(
            res.fields.map((f: { name: string }) => f.name),
            res.rows as unknown[][],
            this.opts.maxRows(),
            ms,
          )
        : {
            columns: [],
            rows: [],
            rowCount: 0,
            affectedRows: typeof res.rowCount === 'number' ? res.rowCount : 0,
            command: res.command,
            truncated: false,
            durationMs: ms,
          };
    if (Array.isArray(raw)) {
      const sets = raw.map((r) => convert(r, 0));
      const main = { ...sets[sets.length - 1], durationMs };
      return sets.length > 1 ? { ...main, statements: sets.length, sets } : main;
    }
    return convert(raw, durationMs);
  }

  async dispose(): Promise<void> {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// SQLite (fichier, lecture seule) — sql.js : SQLite compilé en WebAssembly, aucun module natif
// ---------------------------------------------------------------------------

export { SQLITE_MAX_BYTES };

const readOnlyError = (): Error =>
  new Error(t('Les bases SQLite sont ouvertes en lecture seule : aucune écriture possible.', 'SQLite databases are opened read-only: writing is not possible.'));

/** Premier de ces chemins qui existe : fichier installé avec l'extension (dist/) ou, en développement, node_modules. */
function findFile(...candidates: string[]): string {
  const found = candidates.find((f) => fs.existsSync(f));
  if (!found) {
    throw new Error(t(`Moteur SQLite introuvable (${path.basename(candidates[0])} manquant).`, `SQLite engine not found (${path.basename(candidates[0])} is missing).`));
  }
  return found;
}

interface PendingCall {
  worker: Worker;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * SQLite en lecture seule. Le moteur (sql.js) tourne dans un thread de travail : l'extension n'est
 * jamais bloquée par une requête longue, et l'annulation arrête simplement le thread (le fichier
 * est rechargé à la requête suivante).
 */
export class SqliteDriver implements DbDriver {
  readonly type = 'sqlite' as const;
  private worker?: Worker;
  private seq = 0;
  private readonly pending = new Map<number, PendingCall>();

  constructor(
    private readonly cfg: ConnectionConfig,
    private readonly opts: DriverOptions,
  ) {}

  private start(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const data: WorkerData = {
      file: this.cfg.file ?? '',
      fr: isFrench(),
      wasmPath: findFile(
        path.join(__dirname, 'sql-wasm.wasm'),
        path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
      ),
    };
    const worker = new Worker(findFile(path.join(__dirname, 'sqliteWorker.js')), { workerData: data });
    worker.on('message', (m: WorkerResponse) => {
      const call = this.pending.get(m.id);
      if (!call) {
        return;
      }
      this.pending.delete(m.id);
      this.idle(worker);
      if (m.ok) {
        call.resolve(m.result);
      } else {
        call.reject(new Error(m.error));
      }
    });
    worker.on('error', (err) => this.drop(worker, err));
    worker.on('exit', () => this.drop(worker, new Error(t("Le moteur SQLite s'est arrêté.", 'The SQLite engine has stopped.'))));
    // Après les écouteurs : en ajouter un re-référence le thread. Un pilote oublié ne doit pas retenir le processus.
    worker.unref();
    this.worker = worker;
    return worker;
  }

  /** Oublie ce thread et fait échouer les appels qui l'attendaient. */
  private drop(worker: Worker, err: Error): void {
    if (this.worker === worker) {
      this.worker = undefined;
    }
    for (const [id, call] of this.pending) {
      if (call.worker === worker) {
        this.pending.delete(id);
        call.reject(err);
      }
    }
  }

  /** Thread au repos : il ne doit pas retenir le processus ; avec des appels en attente, il le doit. */
  private idle(worker: Worker): void {
    if (![...this.pending.values()].some((c) => c.worker === worker)) {
      worker.unref();
    }
  }

  private call<T>(req: DistributiveOmit<WorkerRequest, 'id'>, cancel?: CancelToken): Promise<T> {
    if (cancel?.requested) {
      return Promise.reject(new Error(t('Requête annulée.', 'Query cancelled.')));
    }
    const worker = this.start();
    const id = ++this.seq;
    const done = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { worker, resolve: resolve as (v: unknown) => void, reject });
      worker.ref();
      worker.postMessage({ id, ...req });
      cancel?.attach(async () => {
        void worker.terminate();
        this.drop(worker, new Error(t('Requête annulée.', 'Query cancelled.')));
      });
    });
    return done.finally(() => cancel?.detach());
  }

  private async rows(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    return this.call<unknown[][]>({ op: 'rows', sql, params });
  }

  async listContainers(): Promise<string[]> {
    await this.call({ op: 'open' });
    return ['main'];
  }

  async listTables(): Promise<TableInfo[]> {
    const rows = await this.rows(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite!_%' ESCAPE '!' ORDER BY name",
    );
    return rows.map((r) => ({ name: String(r[0]), isView: r[1] === 'view' }));
  }

  async listReferrers(_container: string, table: string): Promise<Referrer[]> {
    const rows = await this.rows(
      'SELECT m.name, f."from", f."to", f.id, f.seq FROM sqlite_master m, pragma_foreign_key_list(m.name) f ' +
        "WHERE m.type = 'table' AND f.\"table\" = ? ORDER BY m.name, f.id, f.seq",
      [table],
    );
    const composite = new Set(rows.filter((r) => Number(r[4]) > 0).map((r) => `${r[0]}\u0000${r[3]}`));
    return rows
      .filter((r) => !composite.has(`${r[0]}\u0000${r[3]}`) && r[2] !== null)
      .map((r) => ({ container: 'main', table: String(r[0]), column: String(r[1]), refColumn: String(r[2]) }));
  }

  async listColumns(_container: string, table: string): Promise<ColumnInfo[]> {
    const q = (n: string) => '"' + n.replace(/"/g, '""') + '"';
    const info = await this.rows(`PRAGMA table_xinfo(${q(table)})`);
    // cid, name, type, notnull, dflt_value, pk, hidden (1 = colonne cachée d'une table virtuelle, 2/3 = générée)
    const cols = info.filter((r) => Number(r[6]) !== 1);
    const pkCount = cols.filter((r) => Number(r[5]) > 0).length;

    const refs = new Map<string, { container: string; table: string; column: string }>();
    const fkRows = await this.rows(`PRAGMA foreign_key_list(${q(table)})`);
    const byId = new Map<number, unknown[][]>();
    for (const r of fkRows) {
      byId.set(Number(r[0]), [...(byId.get(Number(r[0])) ?? []), r]);
    }
    for (const group of byId.values()) {
      if (group.length !== 1) {
        continue; // clé composite : non suivie
      }
      const [, , target, from, to] = group[0];
      let column = to === null || to === undefined ? '' : String(to);
      if (!column) {
        // « REFERENCES t » sans colonne : clé primaire de la table cible
        const tinfo = await this.rows(`PRAGMA table_info(${q(String(target))})`);
        const pks = tinfo.filter((r) => Number(r[5]) > 0);
        column = pks.length === 1 ? String(pks[0][1]) : '';
      }
      if (column) {
        refs.set(String(from), { container: 'main', table: String(target), column });
      }
    }

    return cols.map((r) => {
      const type = String(r[2] ?? '');
      const pk = Number(r[5]) > 0;
      return {
        name: String(r[1]),
        type,
        nullable: Number(r[3]) === 0 && !pk,
        primaryKey: pk,
        // INTEGER PRIMARY KEY (clé seule) = alias du rowid, auto-généré
        hasDefault: r[4] !== null || (pk && pkCount === 1 && /^integer$/i.test(type)),
        generated: Number(r[6]) >= 2,
        references: refs.get(String(r[1])),
      };
    });
  }

  async describeTable(_container: string, table: string): Promise<TableStructure> {
    const q = (n: string) => quoteIdent('sqlite', n);
    const master = await this.rows("SELECT type, sql FROM sqlite_master WHERE name = ? AND type IN ('table','view')", [table]);
    if (master.length === 0) {
      throw new Error(t(`Table ou vue introuvable : ${table}`, `Table or view not found: ${table}`));
    }
    const isView = master[0][0] === 'view';
    const info = (await this.rows(`PRAGMA table_xinfo(${q(table)})`)).filter((r) => Number(r[6]) !== 1);
    const columns: StructureColumn[] = info.map((r) => ({
      name: String(r[1]),
      type: String(r[2] ?? ''),
      nullable: Number(r[3]) === 0 && Number(r[5]) === 0,
      primaryKey: Number(r[5]) > 0,
      default: r[4] === null ? null : String(r[4]),
      extra: Number(r[6]) === 2 ? 'VIRTUAL GENERATED' : Number(r[6]) === 3 ? 'STORED GENERATED' : undefined,
    }));

    const indexes: IndexInfo[] = [];
    const constraints: ConstraintInfo[] = [];
    const pk = info.filter((r) => Number(r[5]) > 0).sort((a, b) => Number(a[5]) - Number(b[5]));
    if (pk.length > 0) {
      constraints.push({ name: 'PRIMARY KEY', kind: 'PRIMARY KEY', definition: `(${pk.map((r) => q(String(r[1]))).join(', ')})` });
    }
    if (!isView) {
      for (const r of await this.rows(`PRAGMA index_list(${q(table)})`)) {
        const name = String(r[1]);
        const cols = (await this.rows(`PRAGMA index_info(${q(name)})`)).map((c) => (c[2] === null ? '(expression)' : String(c[2])));
        const origin = String(r[3]);
        indexes.push({ name, columns: cols, unique: Number(r[2]) === 1, primary: origin === 'pk' });
        if (origin === 'u') {
          constraints.push({ name, kind: 'UNIQUE', definition: `(${cols.map(q).join(', ')})` });
        }
      }
      const fks = new Map<number, unknown[][]>();
      for (const r of await this.rows(`PRAGMA foreign_key_list(${q(table)})`)) {
        fks.set(Number(r[0]), [...(fks.get(Number(r[0])) ?? []), r]);
      }
      for (const [id, group] of fks) {
        const rule = (v: unknown) => (String(v) === 'NO ACTION' ? '' : String(v));
        const upd = rule(group[0][5]);
        const del = rule(group[0][6]);
        constraints.push({
          name: `fk_${id}`,
          kind: 'FOREIGN KEY',
          definition:
            `(${group.map((g) => q(String(g[3]))).join(', ')}) REFERENCES ${q(String(group[0][2]))} ` +
            `(${group.map((g) => (g[4] === null ? '' : q(String(g[4])))).join(', ')})` +
            (upd ? ` ON UPDATE ${upd}` : '') + (del ? ` ON DELETE ${del}` : ''),
        });
      }
    }
    const stmts = [String(master[0][1] ?? '')];
    for (const r of await this.rows('SELECT sql FROM sqlite_master WHERE type = ? AND tbl_name = ? AND sql IS NOT NULL ORDER BY name', ['index', table])) {
      stmts.push(String(r[0]));
    }
    return { isView, columns, indexes, constraints, ddl: stmts.filter(Boolean).map((x) => (x.endsWith(';') ? x : x + ';')).join('\n\n') };
  }

  async query(sql: string, params: unknown[] = [], cancel?: CancelToken): Promise<QueryResult> {
    const started = Date.now();
    const max = this.opts.maxRows();
    const sets = await this.call<RawSet[]>({ op: 'query', sql, params, max }, cancel);
    const results = sets.map((r) => this.pack(r, 0));
    if (results.length === 0) {
      return { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: Date.now() - started };
    }
    const last = { ...results[results.length - 1], durationMs: Date.now() - started };
    return results.length > 1 ? { ...last, statements: results.length, sets: results } : last;
  }

  private pack(raw: RawSet, durationMs: number): QueryResult {
    return {
      columns: raw.columns,
      rows: raw.values.map((row) => row.map((v) => formatCell(v instanceof Uint8Array ? Buffer.from(v) : v))),
      rowCount: raw.total,
      truncated: raw.total > raw.values.length,
      durationMs,
    };
  }

  async executeBatch(): Promise<number[]> {
    throw readOnlyError();
  }

  async insertRow(): Promise<{ row?: (string | null)[]; insertId?: string }> {
    throw readOnlyError();
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    if (worker) {
      this.drop(worker, new Error(t('Connexion fermée.', 'Connection closed.')));
      await worker.terminate();
    }
  }
}

/**
 * `tlsServername` : nom d'hôte à vérifier dans le certificat quand on se connecte par un tunnel
 * (l'adresse réellement jointe est alors 127.0.0.1).
 */
export function createDriver(
  cfg: ConnectionConfig,
  password: string,
  opts: DriverOptions,
  tlsServername?: string,
): DbDriver {
  if (cfg.type === 'sqlite') {
    return new SqliteDriver(cfg, opts);
  }
  return cfg.type === 'mysql'
    ? new MySqlDriver(cfg, password, opts, tlsServername)
    : new PostgresDriver(cfg, password, opts, tlsServername);
}

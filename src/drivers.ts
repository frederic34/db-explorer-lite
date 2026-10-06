import * as mysql from 'mysql2/promise';
import { Pool, types as pgTypes } from 'pg';
import {
  ColumnInfo,
  ConnectionConfig,
  DbDriver,
  DriverOptions,
  QueryResult,
  TableInfo,
  WriteStatement,
} from './types';

function mismatch(actual: number, expected: number): Error {
  return new Error(
    `Opération annulée : ${actual} ligne(s) affectée(s) au lieu de ${expected} attendue(s). ` +
      'Les données ont peut-être été modifiées entre-temps ; actualisez l\'aperçu.',
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
    return value.length <= 32 ? '0x' + value.toString('hex') : `<binaire ${value.length} octets>`;
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
  ) {
    this.pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password,
      database: cfg.database || undefined,
      ssl: cfg.ssl ? {} : undefined,
      connectTimeout: 10000,
      connectionLimit: 3,
      // affectedRows = lignes trouvées (et non seulement modifiées) : un UPDATE qui réécrit
      // la même valeur doit compter comme une ligne affectée.
      flags: ['+FOUND_ROWS'],
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
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

  async listColumns(container: string, table: string): Promise<ColumnInfo[]> {
    const { rows } = await this.run(
      'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS ' +
        'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [container, table],
    );
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

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const t0 = Date.now();
    const { rows, fields } = await this.run(sql, params);
    const durationMs = Date.now() - t0;

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

  async dispose(): Promise<void> {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

/** date, time, timestamp, timestamptz, interval, timetz : on garde le texte renvoyé par le serveur. */
const PG_RAW_TEXT_OIDS = new Set([1082, 1083, 1114, 1184, 1186, 1266]);

export class PostgresDriver implements DbDriver {
  readonly type = 'postgres' as const;
  private readonly pool: Pool;

  constructor(
    cfg: ConnectionConfig,
    password: string,
    private readonly opts: DriverOptions,
  ) {
    this.pool = new Pool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password,
      database: cfg.database || 'postgres',
      ssl: cfg.ssl ? true : undefined,
      connectionTimeoutMillis: 10000,
      max: 3,
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

  private async rows(text: string, values: unknown[]): Promise<unknown[][]> {
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
    return rows.map((r) => {
      const generated = r[7] === 'ALWAYS' || (r[5] === 'YES' && r[6] === 'ALWAYS');
      return {
        name: String(r[0]),
        type: String(r[1]),
        nullable: String(r[2]).toUpperCase() === 'YES',
        primaryKey: r[3] === true,
        hasDefault: r[4] !== null || r[5] === 'YES' || generated,
        generated,
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

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const t0 = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: any = await this.pool.query({ text: sql, values: params, rowMode: 'array' });
    const durationMs = Date.now() - t0;
    // Plusieurs instructions dans le texte : pg renvoie un tableau, on affiche la dernière.
    const res = Array.isArray(raw) ? raw[raw.length - 1] : raw;

    if (res.fields && res.fields.length > 0) {
      return buildResult(
        res.fields.map((f: { name: string }) => f.name),
        res.rows as unknown[][],
        this.opts.maxRows(),
        durationMs,
      );
    }
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: typeof res.rowCount === 'number' ? res.rowCount : 0,
      command: res.command,
      truncated: false,
      durationMs,
    };
  }

  async dispose(): Promise<void> {
    await this.pool.end();
  }
}

export function createDriver(
  cfg: ConnectionConfig,
  password: string,
  opts: DriverOptions,
): DbDriver {
  return cfg.type === 'mysql'
    ? new MySqlDriver(cfg, password, opts)
    : new PostgresDriver(cfg, password, opts);
}

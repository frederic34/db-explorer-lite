import { SchemaView } from './completion';
import { ColumnInfo, ConnectionConfig, DbDriver, TableInfo } from './types';

const TTL_MS = 5 * 60 * 1000;
const MAX_CONTAINERS = 40;

interface Entry<T> {
  at: number;
  value: T;
}

/**
 * Cache du schéma (bases, tables, colonnes) pour l'auto-complétion : rien n'est lu avant la première
 * saisie, et jamais plus d'une fois toutes les 5 minutes (jusqu'à actualisation de l'arbre).
 */
export class SchemaCache {
  private readonly containers = new Map<string, Entry<string[]>>();
  private readonly tables = new Map<string, Entry<TableInfo[]>>();
  private readonly columns = new Map<string, Entry<ColumnInfo[]>>();
  private readonly loading = new Map<string, Promise<void>>();

  constructor(
    private readonly getDriver: (id: string) => Promise<DbDriver>,
    private readonly now: () => number = Date.now,
  ) {}

  invalidate(id?: string): void {
    for (const map of [this.containers, this.tables, this.columns] as Map<string, unknown>[]) {
      for (const key of [...map.keys()]) {
        if (id === undefined || key === id || key.startsWith(id + '\u0000')) {
          map.delete(key);
        }
      }
    }
  }

  private fresh<T>(e: Entry<T> | undefined): T | undefined {
    return e && this.now() - e.at < TTL_MS ? e.value : undefined;
  }

  /** Charge les bases et leurs tables (une seule requête en vol par connexion). */
  load(id: string): Promise<void> {
    if (this.fresh(this.containers.get(id))) {
      return Promise.resolve();
    }
    const running = this.loading.get(id);
    if (running) {
      return running;
    }
    const p = (async () => {
      const driver = await this.getDriver(id);
      const names = (await driver.listContainers()).slice(0, MAX_CONTAINERS);
      const entries = await Promise.all(
        names.map(async (c) => [c, await driver.listTables(c).catch(() => [] as TableInfo[])] as const),
      );
      const at = this.now();
      for (const [c, t] of entries) {
        this.tables.set(`${id}\u0000${c}`, { at, value: t });
      }
      this.containers.set(id, { at, value: names });
    })().finally(() => this.loading.delete(id));
    this.loading.set(id, p);
    return p;
  }

  async loadColumns(id: string, container: string, table: string): Promise<void> {
    const key = `${id}\u0000${container}\u0000${table}`;
    if (this.fresh(this.columns.get(key))) {
      return;
    }
    const driver = await this.getDriver(id);
    this.columns.set(key, { at: this.now(), value: await driver.listColumns(container, table) });
  }

  view(id: string, cfg: ConnectionConfig): SchemaView {
    return {
      dbType: cfg.type,
      containers: this.fresh(this.containers.get(id)) ?? [],
      defaultContainer: cfg.type === 'mysql' ? cfg.database || undefined : cfg.type === 'sqlite' ? 'main' : 'public',
      tables: (c) => this.fresh(this.tables.get(`${id}\u0000${c}`)),
      columns: (c, t) => this.fresh(this.columns.get(`${id}\u0000${c}\u0000${t}`)),
    };
  }
}

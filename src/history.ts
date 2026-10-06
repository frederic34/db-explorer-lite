/** Sous-ensemble de vscode.Memento utilisé ici (facilite les tests). */
export interface Store {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface HistoryEntry {
  sql: string;
  connectionId: string;
  connectionName: string;
  /** Horodatage (ms depuis 1970). */
  at: number;
  ok: boolean;
  ms?: number;
}

const KEY = 'dbExplorer.history';
export const MAX_HISTORY = 200;
/** Une requête plus longue n'est pas conservée en entier (le stockage reste léger). */
const MAX_SQL_LENGTH = 20000;

/** Historique des requêtes exécutées, les plus récentes en premier, sans doublon consécutif. */
export class QueryHistory {
  constructor(private readonly store: Store, private readonly now: () => number = Date.now) {}

  list(): HistoryEntry[] {
    return this.store.get<HistoryEntry[]>(KEY, []);
  }

  async add(entry: Omit<HistoryEntry, 'at'>): Promise<void> {
    const sql = entry.sql.trim().slice(0, MAX_SQL_LENGTH);
    if (!sql) {
      return;
    }
    // La même requête sur la même connexion remonte en tête au lieu de s'accumuler.
    const rest = this.list().filter((e) => !(e.sql === sql && e.connectionId === entry.connectionId));
    const next = [{ ...entry, sql, at: this.now() }, ...rest].slice(0, MAX_HISTORY);
    await this.store.update(KEY, next);
  }

  async clear(): Promise<void> {
    await this.store.update(KEY, []);
  }
}

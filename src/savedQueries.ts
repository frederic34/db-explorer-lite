import { Store } from './history';
import { t } from './i18n';

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  folder?: string;
  /** Connexion d'origine (facultative : sinon elle est demandée à l'exécution). */
  connectionId?: string;
}

const KEY = 'dbExplorer.savedQueries';
const MAX_SQL = 100000;

/** Requêtes favorites, rangées éventuellement dans des dossiers (un seul niveau). */
export class SavedQueries {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: Store,
    private readonly newId: () => string = () => Math.random().toString(36).slice(2) + Date.now().toString(36),
  ) {}

  onDidChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  list(): SavedQuery[] {
    return this.store.get<SavedQuery[]>(KEY, []);
  }

  get(id: string): SavedQuery | undefined {
    return this.list().find((q) => q.id === id);
  }

  folders(): string[] {
    return [...new Set(this.list().flatMap((q) => (q.folder ? [q.folder] : [])))].sort((a, b) => a.localeCompare(b));
  }

  private async write(all: SavedQuery[]): Promise<void> {
    await this.store.update(KEY, all);
    this.listeners.forEach((fn) => fn());
  }

  async add(q: Omit<SavedQuery, 'id'>): Promise<SavedQuery> {
    const name = q.name.trim().slice(0, 120);
    const sql = q.sql.trim().slice(0, MAX_SQL);
    if (!name || !sql) {
      throw new Error(t('Nom et requête obligatoires.', 'Name and query are required.'));
    }
    const created: SavedQuery = { id: this.newId(), name, sql, folder: q.folder?.trim().slice(0, 80) || undefined, connectionId: q.connectionId };
    await this.write([...this.list(), created]);
    return created;
  }

  async update(id: string, patch: Partial<Omit<SavedQuery, 'id'>>): Promise<void> {
    const all = this.list().map((q) => {
      if (q.id !== id) {
        return q;
      }
      const next = { ...q, ...patch };
      next.name = next.name.trim().slice(0, 120) || q.name;
      next.folder = next.folder?.trim().slice(0, 80) || undefined;
      return next;
    });
    await this.write(all);
  }

  async remove(id: string): Promise<void> {
    await this.write(this.list().filter((q) => q.id !== id));
  }

  /** Renomme un dossier ; si le nom existe déjà, les deux fusionnent. */
  async renameFolder(from: string, to: string): Promise<void> {
    const name = to.trim().slice(0, 80);
    if (!name) {
      throw new Error(t('Le nom du dossier ne peut pas être vide.', 'The folder name cannot be empty.'));
    }
    await this.write(this.list().map((q) => (q.folder === from ? { ...q, folder: name } : q)));
  }

  /** Supprime un dossier : ses requêtes reviennent à la racine. */
  async removeFolder(name: string): Promise<void> {
    await this.write(this.list().map((q) => (q.folder === name ? { ...q, folder: undefined } : q)));
  }
}

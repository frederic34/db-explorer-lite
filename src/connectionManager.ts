import * as vscode from 'vscode';
import { createDriver } from './drivers';
import { ConnectionConfig, DbDriver, DriverOptions } from './types';

const STORE_KEY = 'dbExplorer.connections';
const secretKey = (id: string) => `dbExplorer.password.${id}`;

/**
 * Stocke les connexions (globalState) et leurs mots de passe (SecretStorage),
 * et garde un pool de connexions ouvert par connexion configurée.
 */
export class ConnectionManager {
  private readonly drivers = new Map<string, DbDriver>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  private get opts(): DriverOptions {
    return {
      maxRows: () => vscode.workspace.getConfiguration('dbExplorer').get<number>('maxRows', 5000),
      showSystem: () =>
        vscode.workspace.getConfiguration('dbExplorer').get<boolean>('showSystemSchemas', false),
    };
  }

  list(): ConnectionConfig[] {
    return this.ctx.globalState.get<ConnectionConfig[]>(STORE_KEY, []);
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find((c) => c.id === id);
  }

  getPassword(id: string): Thenable<string | undefined> {
    return this.ctx.secrets.get(secretKey(id));
  }

  /** Crée ou met à jour une connexion. password === undefined : on garde l'ancien. */
  async save(cfg: ConnectionConfig, password: string | undefined): Promise<void> {
    const all = this.list();
    const idx = all.findIndex((c) => c.id === cfg.id);
    if (idx >= 0) {
      all[idx] = cfg;
    } else {
      all.push(cfg);
    }
    await this.ctx.globalState.update(STORE_KEY, all);
    if (password !== undefined) {
      await this.ctx.secrets.store(secretKey(cfg.id), password);
    }
    await this.reset(cfg.id);
    this.changed.fire();
  }

  async remove(id: string): Promise<void> {
    await this.ctx.globalState.update(
      STORE_KEY,
      this.list().filter((c) => c.id !== id),
    );
    await this.ctx.secrets.delete(secretKey(id));
    await this.reset(id);
    this.changed.fire();
  }

  async getDriver(id: string): Promise<DbDriver> {
    const existing = this.drivers.get(id);
    if (existing) {
      return existing;
    }
    const cfg = this.get(id);
    if (!cfg) {
      throw new Error('Connexion introuvable (supprimée ?).');
    }
    const password = (await this.getPassword(id)) ?? '';
    const driver = createDriver(cfg, password, this.opts);
    this.drivers.set(id, driver);
    return driver;
  }

  /** Ferme le pool d'une connexion ; il sera recréé à la prochaine utilisation. */
  async reset(id: string): Promise<void> {
    const driver = this.drivers.get(id);
    if (driver) {
      this.drivers.delete(id);
      await driver.dispose().catch(() => undefined);
    }
  }

  /** Vérifie qu'une configuration permet de se connecter (SELECT 1). */
  async test(cfg: ConnectionConfig, password: string): Promise<void> {
    const driver = createDriver(cfg, password, this.opts);
    try {
      await driver.query('SELECT 1');
    } finally {
      await driver.dispose().catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    const all = [...this.drivers.values()];
    this.drivers.clear();
    await Promise.all(all.map((d) => d.dispose().catch(() => undefined)));
    this.changed.dispose();
  }
}

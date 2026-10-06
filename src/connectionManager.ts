import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { createDriver } from './drivers';
import { openTunnel, Tunnel } from './tunnel';
import { ConnectionConfig, DbDriver, DriverOptions } from './types';

const STORE_KEY = 'dbExplorer.connections';
const HOSTS_KEY = 'dbExplorer.sshHosts';
const secretKey = (id: string) => `dbExplorer.password.${id}`;
const sshSecretKey = (id: string) => `dbExplorer.sshsecret.${id}`;

const expandHome = (p: string): string => (p === '~' || p.startsWith('~/') ? os.homedir() + p.slice(1) : p);

/**
 * Stocke les connexions (globalState) et leurs mots de passe (SecretStorage),
 * et garde un pool de connexions ouvert par connexion configurée (avec son tunnel SSH éventuel).
 */
export class ConnectionManager {
  private readonly drivers = new Map<string, DbDriver>();
  private readonly pending = new Map<string, Promise<DbDriver>>();
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

  /** Mot de passe SSH, ou phrase secrète de la clé privée. */
  getSshSecret(id: string): Thenable<string | undefined> {
    return this.ctx.secrets.get(sshSecretKey(id));
  }

  /** Crée ou met à jour une connexion. password / sshSecret === undefined : on garde l'ancien. */
  async save(cfg: ConnectionConfig, password: string | undefined, sshSecret?: string): Promise<void> {
    if (cfg.type === 'sqlite') {
      cfg = { ...cfg, readOnly: true, ssh: undefined, production: undefined };
    }
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
    if (!cfg.ssh) {
      await this.ctx.secrets.delete(sshSecretKey(cfg.id));
    } else if (sshSecret !== undefined) {
      await this.ctx.secrets.store(sshSecretKey(cfg.id), sshSecret);
    }
    await this.reset(cfg.id);
    this.changed.fire();
  }

  /** Noms des groupes existants, triés. */
  groups(): string[] {
    return [...new Set(this.list().flatMap((c) => (c.group ? [c.group] : [])))].sort((a, b) => a.localeCompare(b));
  }

  /** Range des connexions dans un groupe (undefined = hors de tout groupe). */
  async setGroup(ids: string[], group: string | undefined): Promise<void> {
    const name = group?.trim() || undefined;
    await this.ctx.globalState.update(
      STORE_KEY,
      this.list().map((c) => (ids.includes(c.id) ? { ...c, group: name } : c)),
    );
    this.changed.fire();
  }

  /** Renomme un groupe ; si le nouveau nom existe déjà, les deux sont fusionnés. */
  async renameGroup(from: string, to: string): Promise<void> {
    const name = to.trim();
    if (!name) {
      throw new Error('Le nom du groupe est vide.');
    }
    await this.ctx.globalState.update(
      STORE_KEY,
      this.list().map((c) => (c.group === from ? { ...c, group: name } : c)),
    );
    this.changed.fire();
  }

  /** Supprime un groupe : ses connexions sont conservées, hors de tout groupe. */
  async removeGroup(name: string): Promise<void> {
    await this.ctx.globalState.update(
      STORE_KEY,
      this.list().map((c) => (c.group === name ? { ...c, group: undefined } : c)),
    );
    this.changed.fire();
  }

  async remove(id: string): Promise<void> {
    await this.ctx.globalState.update(
      STORE_KEY,
      this.list().filter((c) => c.id !== id),
    );
    await this.ctx.secrets.delete(secretKey(id));
    await this.ctx.secrets.delete(sshSecretKey(id));
    await this.reset(id);
    this.changed.fire();
  }

  /** Serveurs SSH approuvés (« hôte:port » → empreinte), oubliés par la commande dédiée. */
  async forgetSshHosts(): Promise<void> {
    await this.ctx.globalState.update(HOSTS_KEY, {});
  }

  /**
   * Clé du serveur SSH : première connexion = confirmation de l'empreinte par l'utilisateur ;
   * ensuite l'empreinte doit rester identique (sinon refus : serveur remplacé ou attaque).
   */
  private async verifyHostKey(host: string, port: number, fingerprint: string): Promise<boolean> {
    const known = this.ctx.globalState.get<Record<string, string>>(HOSTS_KEY, {});
    const key = `${host}:${port}`;
    if (known[key] === fingerprint) {
      return true;
    }
    if (known[key]) {
      void vscode.window.showErrorMessage(
        `⚠ L'empreinte du serveur SSH ${key} a changé (attendue ${known[key]}, reçue ${fingerprint}). ` +
          'Connexion refusée : le serveur a peut-être été réinstallé, ou quelqu\'un se fait passer pour lui. ' +
          'Si le changement est légitime, utilisez « DB Explorer : Oublier les serveurs SSH approuvés ».',
      );
      return false;
    }
    const trust = 'Faire confiance';
    const choice = await vscode.window.showWarningMessage(
      `Première connexion au serveur SSH ${key}`,
      { modal: true, detail: `Empreinte de sa clé :\n${fingerprint}\n\nVérifiez-la auprès de l'administrateur du serveur avant de continuer.` },
      trust,
    );
    if (choice !== trust) {
      return false;
    }
    await this.ctx.globalState.update(HOSTS_KEY, { ...known, [key]: fingerprint });
    return true;
  }

  /** Crée le pilote, en passant par un tunnel SSH si la connexion en définit un. */
  private async connect(
    cfg: ConnectionConfig,
    password: string,
    sshSecret: string,
    onTunnelClosed?: (reason?: string) => void,
  ): Promise<DbDriver> {
    if (!cfg.ssh) {
      return createDriver(cfg, password, this.opts);
    }
    const ssh = cfg.ssh;
    let privateKey: string | undefined;
    if (ssh.authMethod === 'key') {
      if (!ssh.keyPath) {
        throw new Error('Aucune clé privée SSH indiquée.');
      }
      try {
        privateKey = fs.readFileSync(expandHome(ssh.keyPath), 'utf8');
      } catch (err) {
        throw new Error(`Clé privée SSH illisible (${ssh.keyPath}) : ${(err as Error).message}`);
      }
    }
    const tunnel: Tunnel = await openTunnel(
      {
        host: ssh.host,
        port: ssh.port,
        username: ssh.user,
        password: ssh.authMethod === 'password' ? sshSecret : undefined,
        privateKey,
        passphrase: ssh.authMethod === 'key' && sshSecret ? sshSecret : undefined,
        agent:
          ssh.authMethod === 'agent'
            ? process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
            : undefined,
        verifyHostKey: (fp) => this.verifyHostKey(ssh.host, ssh.port, fp),
      },
      { host: cfg.host, port: cfg.port },
    );
    if (onTunnelClosed) {
      tunnel.onClose(onTunnelClosed);
    }
    try {
      const inner = createDriver({ ...cfg, host: '127.0.0.1', port: tunnel.localPort }, password, this.opts, cfg.host);
      const dispose = inner.dispose.bind(inner);
      inner.dispose = async () => {
        await dispose().catch(() => undefined);
        await tunnel.close();
      };
      return inner;
    } catch (err) {
      await tunnel.close();
      throw err;
    }
  }

  async getDriver(id: string): Promise<DbDriver> {
    const existing = this.drivers.get(id);
    if (existing) {
      return existing;
    }
    // Appels simultanés : un seul tunnel / pool est créé.
    const running = this.pending.get(id);
    if (running) {
      return running;
    }
    const cfg = this.get(id);
    if (!cfg) {
      throw new Error('Connexion introuvable (supprimée ?).');
    }
    const p = (async () => {
      const password = (await this.getPassword(id)) ?? '';
      const sshSecret = (await this.getSshSecret(id)) ?? '';
      let driver: DbDriver | undefined;
      driver = await this.connect(cfg, password, sshSecret, (reason) => {
        // Liaison SSH perdue : le pilote devient inutilisable, il sera recréé à la prochaine requête.
        if (driver && this.drivers.get(id) === driver) {
          this.drivers.delete(id);
          void driver.dispose();
          void vscode.window.showWarningMessage(
            `Tunnel SSH fermé pour « ${cfg.name} »${reason ? ` (${reason})` : ''}. Il sera rétabli à la prochaine requête.`,
          );
        }
      });
      this.drivers.set(id, driver);
      return driver;
    })().finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }

  /** Ferme le pool (et le tunnel) d'une connexion ; ils seront recréés à la prochaine utilisation. */
  async reset(id: string): Promise<void> {
    const driver = this.drivers.get(id);
    if (driver) {
      this.drivers.delete(id);
      await driver.dispose().catch(() => undefined);
    }
  }

  /** Vérifie qu'une configuration permet de se connecter (SELECT 1). */
  async test(cfg: ConnectionConfig, password: string, sshSecret = ''): Promise<void> {
    const driver = await this.connect(cfg, password, sshSecret);
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

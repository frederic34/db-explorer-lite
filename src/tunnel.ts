import { createHash } from 'crypto';
import * as net from 'net';
import { Client } from 'ssh2';
import { t } from './i18n';

export interface SshOptions {
  host: string;
  port: number;
  username: string;
  /** Mot de passe SSH (authentification par mot de passe). */
  password?: string;
  /** Contenu de la clé privée (authentification par clé). */
  privateKey?: string | Buffer;
  passphrase?: string;
  /** Socket de l'agent SSH (authentification par agent). */
  agent?: string;
  /** Délai de connexion, en ms. */
  timeoutMs?: number;
  /**
   * Vérification de la clé du serveur (empreinte « SHA256:… »). Doit renvoyer true pour continuer ;
   * sans elle, aucune vérification n'est faite.
   */
  verifyHostKey?: (fingerprint: string) => Promise<boolean>;
}

export interface Tunnel {
  /** Port local (127.0.0.1) qui aboutit à la cible, à travers le serveur SSH. */
  readonly localPort: number;
  /** Appelé une fois, quand la liaison SSH est coupée (par le serveur, le réseau ou close()). */
  onClose(listener: (reason?: string) => void): void;
  close(): Promise<void>;
}

/** Empreinte au format d'OpenSSH : SHA256:<base64 sans « = »>. */
export function fingerprintOf(hexSha256: string): string {
  return 'SHA256:' + Buffer.from(hexSha256, 'hex').toString('base64').replace(/=+$/, '');
}

export function fingerprintOfKey(publicKeyBlob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(publicKeyBlob).digest('base64').replace(/=+$/, '');
}

/** Messages d'erreur ssh2 rendus compréhensibles. */
function explain(err: Error, o: SshOptions): Error {
  const m = err.message;
  let text = m;
  if (/All configured authentication methods failed/i.test(m)) {
    text = t(`Authentification SSH refusée pour « ${o.username} » sur ${o.host}:${o.port} (identifiants ou clé invalides).`, `SSH authentication refused for “${o.username}” on ${o.host}:${o.port} (invalid credentials or key).`);
  } else if (/Timed out while waiting for handshake|ETIMEDOUT/i.test(m)) {
    text = t(`Le serveur SSH ${o.host}:${o.port} ne répond pas (délai dépassé).`, `SSH server ${o.host}:${o.port} is not responding (timed out).`);
  } else if (/ECONNREFUSED/i.test(m)) {
    text = t(`Connexion SSH refusée par ${o.host}:${o.port}.`, `SSH connection refused by ${o.host}:${o.port}.`);
  } else if (/ENOTFOUND|EAI_AGAIN/i.test(m)) {
    text = t(`Hôte SSH introuvable : ${o.host}.`, `SSH host not found: ${o.host}.`);
  } else if (/passphrase/i.test(m)) {
    text = t('La clé privée est chiffrée : saisissez sa phrase secrète (champ « mot de passe SSH »), ou elle est incorrecte.', 'The private key is encrypted: enter its passphrase (“SSH password” field), or it is incorrect.');
  } else if (/Cannot parse privateKey|Unsupported key format/i.test(m)) {
    text = t('Clé privée illisible ou format non pris en charge (PEM / OpenSSH attendus).', 'Unreadable private key or unsupported format (PEM / OpenSSH expected).');
  } else if (/Host key rejected|host key|Host denied|verification failed/i.test(m)) {
    text = t('Connexion SSH annulée : clé du serveur non approuvée.', 'SSH connection cancelled: server key not trusted.');
  } else if (/No authentication methods available|Not authenticated/i.test(m)) {
    text = t('Aucune méthode d\'authentification SSH disponible (mot de passe, clé ou agent requis).', 'No SSH authentication method available (password, key or agent required).');
  }
  return new Error(text);
}

/**
 * Ouvre une liaison SSH puis un port local qui redirige vers `target` (vu depuis le serveur SSH).
 * Chaque connexion locale devient un canal « direct-tcpip » : le pool de connexions de la base
 * est donc multiplexé sur une seule session SSH.
 */
export function openTunnel(o: SshOptions, target: { host: string; port: number }): Promise<Tunnel> {
  return new Promise<Tunnel>((resolve, reject) => {
    const client = new Client();
    const sockets = new Set<net.Socket>();
    const listeners: ((reason?: string) => void)[] = [];
    let server: net.Server | undefined;
    let ready = false;
    let closed = false;

    const closeAll = (reason?: string): void => {
      if (closed) {
        return;
      }
      closed = true;
      for (const s of sockets) {
        s.destroy();
      }
      sockets.clear();
      server?.close();
      client.end();
      client.destroy();
      if (ready) {
        listeners.forEach((l) => l(reason));
      }
    };

    client.on('error', (err) => {
      if (!ready) {
        closeAll();
        reject(explain(err, o));
      } else {
        closeAll(err.message);
      }
    });
    client.on('close', () => closeAll(t('connexion SSH fermée', 'SSH connection closed')));
    client.on('end', () => closeAll(t('connexion SSH terminée', 'SSH connection ended')));

    client.on('ready', () => {
      server = net.createServer((sock) => {
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
        sock.on('error', () => sock.destroy());
        client.forwardOut(sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, target.host, target.port, (err, stream) => {
          if (err) {
            sock.destroy();
            return;
          }
          stream.on('error', () => sock.destroy());
          stream.on('close', () => sock.destroy());
          sock.pipe(stream).pipe(sock);
        });
      });
      server.on('error', (e) => {
        closeAll();
        reject(e);
      });
      server.listen(0, '127.0.0.1', () => {
        ready = true;
        const port = (server?.address() as net.AddressInfo).port;
        resolve({
          localPort: port,
          onClose: (l) => {
            listeners.push(l);
          },
          close: async () => closeAll(t('fermé', 'closed')),
        });
      });
    });

    try {
      client.connect({
        host: o.host,
        port: o.port,
        username: o.username,
        password: o.password,
        privateKey: o.privateKey,
        passphrase: o.passphrase,
        agent: o.agent,
        readyTimeout: o.timeoutMs ?? 15000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        ...(o.verifyHostKey
          ? {
              hostHash: 'sha256' as const,
              hostVerifier: ((hash: string, cb: (ok: boolean) => void) => {
                o.verifyHostKey!(fingerprintOf(hash)).then(
                  (ok) => cb(ok),
                  () => cb(false),
                );
              }) as unknown as (hash: string) => boolean,
            }
          : {}),
      });
    } catch (err) {
      closeAll();
      reject(explain(err as Error, o));
    }
  });
}

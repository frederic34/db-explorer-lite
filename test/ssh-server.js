// Faux serveur SSH (ssh2) pour les tests : authentification par mot de passe ou clé, redirections direct-tcpip.
const net = require('net');
const { generateKeyPairSync } = require('crypto');
const { Server, utils } = require('ssh2');

const rsa = (extra = {}) =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem', ...extra },
  });

/**
 * options : { user, password?, authorizedKey? (clé privée PEM dont la clé publique est autorisée) }
 * Retourne { port, hostFingerprint, forwards, logins, dropClients(), close() }.
 */
async function startSshServer(options) {
  const host = rsa();
  const hostParsed = utils.parseKey(host.privateKey);
  const { createHash } = require('crypto');
  const hostFingerprint = 'SHA256:' + createHash('sha256').update(hostParsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
  const authorized = options.authorizedKey ? utils.parseKey(options.authorizedKey) : undefined;

  const forwards = [];
  const logins = [];
  const clients = new Set();
  const sockets = new Set();

  const server = new Server({ hostKeys: [host.privateKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => undefined);
    client
      .on('authentication', (ctx) => {
        if (ctx.username !== options.user) {
          return ctx.reject(['password', 'publickey']);
        }
        if (ctx.method === 'password' && options.password !== undefined && ctx.password === options.password) {
          logins.push({ method: 'password' });
          return ctx.accept();
        }
        if (ctx.method === 'publickey' && authorized) {
          const key = authorized.getPublicSSH();
          if (ctx.key.algo === authorized.type && Buffer.compare(ctx.key.data, key) === 0) {
            if (!ctx.signature) {
              return ctx.accept(); // simple sondage : « cette clé serait-elle acceptée ? »
            }
            if (authorized.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) {
              logins.push({ method: 'publickey' });
              return ctx.accept();
            }
          }
        }
        return ctx.reject(['password', 'publickey']);
      })
      .on('ready', () => {
        client.on('tcpip', (accept, reject, info) => {
          forwards.push({ host: info.destIP, port: info.destPort });
          const sock = net.connect(info.destPort, info.destIP);
          sockets.add(sock);
          sock.on('close', () => sockets.delete(sock));
          sock.on('error', () => reject());
          sock.on('connect', () => {
            const stream = accept();
            stream.on('error', () => sock.destroy());
            sock.on('error', () => stream.destroy());
            stream.pipe(sock).pipe(stream);
          });
        });
      });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    hostFingerprint,
    forwards,
    logins,
    /** Coupe de force toutes les sessions SSH ouvertes (panne réseau simulée). */
    dropClients: () => clients.forEach((c) => c.end()),
    close: async () => {
      clients.forEach((c) => c.end());
      sockets.forEach((s) => s.destroy());
      await new Promise((r) => server.close(r));
    },
  };
}

module.exports = { startSshServer, rsa };

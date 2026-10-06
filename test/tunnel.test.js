// Tunnel SSH : serveur SSH factice + serveur « écho » local (aucune base de données nécessaire).
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { openTunnel, fingerprintOf } = require('../.test-build/tunnel.js');
const { startSshServer, rsa } = require('./ssh-server');

/** Serveur TCP qui renvoie en majuscules ce qu'il reçoit. */
async function startEcho() {
  const conns = new Set();
  const server = net.createServer((s) => {
    conns.add(s);
    s.on('close', () => conns.delete(s));
    s.on('error', () => undefined);
    s.on('data', (d) => s.write(d.toString().toUpperCase()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: async () => { conns.forEach((c) => c.destroy()); await new Promise((r) => server.close(r)); } };
}

const talk = (port, text) =>
  new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('error', reject);
    s.on('close', () => reject(new Error('socket closed')));
    s.once('data', (d) => { s.destroy(); resolve(d.toString()); });
    s.write(text);
  });

test('fingerprintOf : hex SHA-256 → format OpenSSH', () => {
  assert.equal(fingerprintOf('00'.repeat(32)), 'SHA256:' + 'A'.repeat(43));
});

test('mot de passe : le trafic passe par le serveur SSH jusqu\'à la cible', async () => {
  const echo = await startEcho();
  const ssh = await startSshServer({ user: 'fred', password: 's3cret' });
  const tunnel = await openTunnel({ host: '127.0.0.1', port: ssh.port, username: 'fred', password: 's3cret' }, { host: '127.0.0.1', port: echo.port });
  try {
    assert.ok(tunnel.localPort > 0);
    assert.equal(await talk(tunnel.localPort, 'bonjour'), 'BONJOUR');
    assert.deepEqual(ssh.forwards, [{ host: '127.0.0.1', port: echo.port }], 'la redirection a bien été demandée au serveur SSH');
    assert.deepEqual(ssh.logins, [{ method: 'password' }]);
  } finally { await tunnel.close(); await ssh.close(); await echo.close(); }
});

test('connexions simultanées multiplexées sur une seule session SSH', async () => {
  const echo = await startEcho();
  const ssh = await startSshServer({ user: 'u', password: 'p' });
  const tunnel = await openTunnel({ host: '127.0.0.1', port: ssh.port, username: 'u', password: 'p' }, { host: '127.0.0.1', port: echo.port });
  try {
    const out = await Promise.all(Array.from({ length: 12 }, (_, i) => talk(tunnel.localPort, 'msg' + i)));
    assert.deepEqual(out, Array.from({ length: 12 }, (_, i) => 'MSG' + i));
    assert.equal(ssh.logins.length, 1, 'une seule authentification');
    assert.equal(ssh.forwards.length, 12);
  } finally { await tunnel.close(); await ssh.close(); await echo.close(); }
});

test('mauvais mot de passe, mauvais utilisateur : erreur claire', async () => {
  const ssh = await startSshServer({ user: 'fred', password: 'bon' });
  try {
    await assert.rejects(openTunnel({ host: '127.0.0.1', port: ssh.port, username: 'fred', password: 'mauvais' }, { host: '127.0.0.1', port: 1 }),
      /Authentification SSH refusée pour « fred »/);
    await assert.rejects(openTunnel({ host: '127.0.0.1', port: ssh.port, username: 'autre', password: 'bon' }, { host: '127.0.0.1', port: 1 }),
      /Authentification SSH refusée/);
    await assert.rejects(openTunnel({ host: '127.0.0.1', port: ssh.port, username: 'fred' }, { host: '127.0.0.1', port: 1 }),
      /Authentification SSH refusée|Aucune méthode/);
    assert.equal(ssh.logins.length, 0);
  } finally { await ssh.close(); }
});

test('clé privée (sans et avec phrase secrète)', async () => {
  const echo = await startEcho();
  const plain = rsa();
  const locked = rsa({ cipher: 'aes-256-cbc', passphrase: 'phrase' });
  const ssh1 = await startSshServer({ user: 'k', authorizedKey: plain.privateKey });
  const ssh2 = await startSshServer({ user: 'k', authorizedKey: locked.privateKey.length ? require('crypto').createPrivateKey({ key: locked.privateKey, passphrase: 'phrase' }).export({ type: 'pkcs1', format: 'pem' }) : '' });
  try {
    const t1 = await openTunnel({ host: '127.0.0.1', port: ssh1.port, username: 'k', privateKey: plain.privateKey }, { host: '127.0.0.1', port: echo.port });
    assert.equal(await talk(t1.localPort, 'cle'), 'CLE');
    assert.deepEqual(ssh1.logins, [{ method: 'publickey' }]);
    await t1.close();

    const t2 = await openTunnel({ host: '127.0.0.1', port: ssh2.port, username: 'k', privateKey: locked.privateKey, passphrase: 'phrase' }, { host: '127.0.0.1', port: echo.port });
    assert.equal(await talk(t2.localPort, 'phrase'), 'PHRASE');
    await t2.close();

    await assert.rejects(openTunnel({ host: '127.0.0.1', port: ssh2.port, username: 'k', privateKey: locked.privateKey }, { host: '127.0.0.1', port: echo.port }), /phrase secrète/);
    await assert.rejects(openTunnel({ host: '127.0.0.1', port: ssh2.port, username: 'k', privateKey: locked.privateKey, passphrase: 'fausse' }, { host: '127.0.0.1', port: echo.port }), /phrase secrète/);
    await assert.rejects(openTunnel({ host: '127.0.0.1', port: ssh2.port, username: 'k', privateKey: 'pas une clé' }, { host: '127.0.0.1', port: echo.port }), /illisible|Aucune|refusée/);
    // clé valide mais non autorisée
    await assert.rejects(openTunnel({ host: '127.0.0.1', port: ssh1.port, username: 'k', privateKey: rsa().privateKey }, { host: '127.0.0.1', port: echo.port }), /refusée/);
  } finally { await ssh1.close(); await ssh2.close(); await echo.close(); }
});

test('empreinte du serveur : transmise au vérificateur, refus = pas de connexion', async () => {
  const echo = await startEcho();
  const ssh = await startSshServer({ user: 'u', password: 'p' });
  try {
    const seen = [];
    const t = await openTunnel({ host: '127.0.0.1', port: ssh.port, username: 'u', password: 'p',
      verifyHostKey: async (fp) => { seen.push(fp); return true; } }, { host: '127.0.0.1', port: echo.port });
    assert.deepEqual(seen, [ssh.hostFingerprint], 'même empreinte que « ssh-keygen -lf »');
    assert.equal(await talk(t.localPort, 'ok'), 'OK');
    await t.close();

    await assert.rejects(openTunnel({ host: '127.0.0.1', port: ssh.port, username: 'u', password: 'p',
      verifyHostKey: async () => false }, { host: '127.0.0.1', port: echo.port }), /clé du serveur non approuvée/);
    assert.equal(ssh.logins.length, 1, 'aucune authentification envoyée à un serveur non approuvé');

    await assert.rejects(openTunnel({ host: '127.0.0.1', port: ssh.port, username: 'u', password: 'p',
      verifyHostKey: async () => { throw new Error('boum'); } }, { host: '127.0.0.1', port: echo.port }), /non approuvée/);
    assert.equal(ssh.logins.length, 1);
  } finally { await ssh.close(); await echo.close(); }
});

test('hôte injoignable, port fermé, délai : erreurs lisibles', async () => {
  await assert.rejects(openTunnel({ host: '127.0.0.1', port: 1, username: 'u', password: 'p' }, { host: 'x', port: 1 }), /Connexion SSH refusée par 127\.0\.0\.1:1/);
  await assert.rejects(openTunnel({ host: 'hote-inexistant.invalid', port: 22, username: 'u', password: 'p' }, { host: 'x', port: 1 }), /introuvable|refusée|ne répond pas/);
  // serveur qui accepte la connexion TCP mais ne parle pas SSH → délai
  const mute = net.createServer(() => undefined);
  await new Promise((r) => mute.listen(0, '127.0.0.1', r));
  try {
    const t0 = Date.now();
    await assert.rejects(openTunnel({ host: '127.0.0.1', port: mute.address().port, username: 'u', password: 'p', timeoutMs: 800 }, { host: 'x', port: 1 }), /ne répond pas/);
    assert.ok(Date.now() - t0 < 5000);
  } finally { mute.close(); }
});

test('cible inaccessible depuis le serveur SSH : la connexion locale est fermée sans bloquer le tunnel', async () => {
  const echo = await startEcho();
  const ssh = await startSshServer({ user: 'u', password: 'p' });
  const dead = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const bad = await openTunnel({ host: '127.0.0.1', port: ssh.port, username: 'u', password: 'p' }, { host: '127.0.0.1', port: dead });
  try {
    await assert.rejects(talk(bad.localPort, 'x'), /ECONNRESET|socket closed/i);
  } finally { await bad.close(); }
  const good = await openTunnel({ host: '127.0.0.1', port: ssh.port, username: 'u', password: 'p' }, { host: '127.0.0.1', port: echo.port });
  assert.equal(await talk(good.localPort, 'encore'), 'ENCORE');
  await good.close(); await ssh.close(); await echo.close();
});

test('fermeture : port local libéré, onClose appelé une fois ; coupure réseau : onClose aussi', async () => {
  const echo = await startEcho();
  const ssh = await startSshServer({ user: 'u', password: 'p' });
  try {
    const t = await openTunnel({ host: '127.0.0.1', port: ssh.port, username: 'u', password: 'p' }, { host: '127.0.0.1', port: echo.port });
    let closed = 0;
    t.onClose(() => closed++);
    await talk(t.localPort, 'x');
    await t.close(); await t.close();
    assert.equal(closed, 1);
    await assert.rejects(talk(t.localPort, 'x'), /ECONNREFUSED/);

    const t2 = await openTunnel({ host: '127.0.0.1', port: ssh.port, username: 'u', password: 'p' }, { host: '127.0.0.1', port: echo.port });
    const reason = new Promise((r) => t2.onClose(r));
    ssh.dropClients();
    assert.match(String(await Promise.race([reason, new Promise((r) => setTimeout(() => r('TROP LONG'), 5000))])), /SSH|fermée|terminée|ECONN/i);
    await assert.rejects(talk(t2.localPort, 'x'), /ECONNREFUSED/);
  } finally { await ssh.close(); await echo.close(); }
});

// Formulaire de connexion (jsdom) : champs, validation, tunnel SSH, drapeaux de sécurité.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { openConnectionForm } = require('../.test-build/form.js');

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const $ = (d, id) => d.getElementById(id);

function manager(over = {}) {
  const calls = { test: [], save: [] };
  return {
    calls,
    groups: () => ['Clients', 'Production'],
    getPassword: async () => 'mdp-stocké',
    getSshSecret: async () => 'secret-ssh-stocké',
    test: async (cfg, pw, ssh) => { calls.test.push({ cfg, pw, ssh }); },
    save: async (cfg, pw, ssh) => { calls.save.push({ cfg, pw, ssh }); },
    ...over,
  };
}

function open(mgr, existing) {
  global.__vsPanels.forEach((p) => { if (!p.disposed) { p.dispose(); } });   // un seul formulaire « nouveau » à la fois
  const before = global.__vsPanels.length;
  openConnectionForm(mgr, existing);
  const panel = global.__vsPanels[before];
  const sent = [];
  const dom = new JSDOM(panel.html, { runScripts: 'dangerously', beforeParse(w) {
    global.__vsWin = w;
    w.acquireVsCodeApi = () => ({ postMessage: (m) => { sent.push(m); panel.handlers.forEach((h) => h(m)); } });
  } });
  const d = dom.window.document, w = dom.window;
  return {
    panel, d, w, sent,
    type: (id, v) => { const el = $(d, id); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); },
    check: (id, on) => { const el = $(d, id); el.checked = on; el.dispatchEvent(new w.Event('change', { bubbles: true })); },
    choose: (id, v) => { const el = $(d, id); el.value = v; el.dispatchEvent(new w.Event('change', { bubbles: true })); },
    hidden: (id) => $(d, id).hidden,
    status: () => ({ cls: $(d, 'status').className, text: $(d, 'status').textContent }),
  };
}

test('création : défauts, bascule MySQL ↔ PostgreSQL, tunnel masqué', () => {
  const f = open(manager());
  assert.equal($(f.d, 'port').value, '3306');
  assert.equal($(f.d, 'user').value, 'root');
  assert.equal(f.hidden('sshBox'), true);
  f.d.querySelector('input[value=postgres]').click();
  assert.equal($(f.d, 'port').value, '5432');
  assert.equal($(f.d, 'database').value, 'postgres');
});

test('tunnel SSH : affichage selon la méthode, libellés', () => {
  const f = open(manager());
  f.check('sshOn', true);
  assert.equal(f.hidden('sshBox'), false);
  assert.equal(f.hidden('sshKeyRow'), true);
  assert.equal(f.hidden('sshPwRow'), false);
  assert.equal($(f.d, 'sshSecretLabel').textContent, 'Mot de passe SSH');
  assert.equal($(f.d, 'sshPort').value, '22');
  f.choose('sshAuth', 'key');
  assert.equal(f.hidden('sshKeyRow'), false);
  assert.equal(f.hidden('sshPwRow'), false);
  assert.match($(f.d, 'sshSecretLabel').textContent, /Phrase secrète/);
  f.choose('sshAuth', 'agent');
  assert.equal(f.hidden('sshKeyRow'), true);
  assert.equal(f.hidden('sshPwRow'), true);
  f.check('sshOn', false);
  assert.equal(f.hidden('sshBox'), true);
});

test('tunnel SSH : validation des champs avant tout envoi', async () => {
  const f = open(manager());
  f.type('host', 'db.interne'); f.type('user', 'app');
  f.check('sshOn', true);
  $(f.d, 'testBtn').click(); await tick();
  assert.equal(f.sent.length, 0, 'rien envoyé');
  assert.match($(f.d, 'err-sshHost').textContent, /obligatoire/);
  assert.match($(f.d, 'err-sshUser').textContent, /obligatoire/);
  f.type('sshHost', 'bastion.exemple.fr'); f.type('sshUser', 'fred'); f.type('sshPort', '70000');
  $(f.d, 'testBtn').click(); await tick();
  assert.equal(f.sent.length, 0);
  assert.match($(f.d, 'err-sshPort').textContent, /1 et 65535/);
  f.type('sshPort', '2222'); f.choose('sshAuth', 'key');
  $(f.d, 'testBtn').click(); await tick();
  assert.equal(f.sent.length, 0);
  assert.match($(f.d, 'err-sshKey').textContent, /clé privée/);
  // tunnel désactivé : ses champs ne bloquent plus
  f.check('sshOn', false);
  $(f.d, 'testBtn').click(); await tick();
  assert.equal(f.sent.length, 1);
});

test('enregistrement avec tunnel (mot de passe) : configuration et secrets transmis', async () => {
  const m = manager();
  const f = open(m);
  f.type('host', 'localhost'); f.type('user', 'app'); f.type('password', 'mdp-base');
  f.check('sshOn', true);
  f.type('sshHost', ' bastion.exemple.fr '); f.type('sshPort', '2200'); f.type('sshUser', 'fred'); f.type('sshSecret', 'mdp-ssh');
  f.check('production', true); f.check('readOnly', true);
  $(f.d, 'saveBtn').click(); await tick(60);
  assert.equal(m.calls.save.length, 1);
  const { cfg, pw, ssh } = m.calls.save[0];
  assert.deepEqual(cfg.ssh, { host: 'bastion.exemple.fr', port: 2200, user: 'fred', authMethod: 'password', keyPath: undefined });
  assert.equal(cfg.production, true); assert.equal(cfg.readOnly, true);
  assert.equal(pw, 'mdp-base'); assert.equal(ssh, 'mdp-ssh');
  assert.ok(f.panel.disposed, 'formulaire fermé après enregistrement');
});

test('clé privée : sélecteur de fichier, chemin enregistré, test avec phrase secrète', async () => {
  const m = manager();
  const f = open(m);
  f.type('host', 'localhost'); f.type('user', 'app');
  f.check('sshOn', true); f.choose('sshAuth', 'key');
  f.type('sshHost', 'bastion'); f.type('sshUser', 'fred');
  global.__openPick = [{ fsPath: '/home/fred/.ssh/id_ed25519' }];
  $(f.d, 'pickKey').click(); await tick();
  assert.equal($(f.d, 'sshKey').value, '/home/fred/.ssh/id_ed25519');
  f.type('sshSecret', 'phrase');
  $(f.d, 'testBtn').click(); await tick(60);
  assert.equal(m.calls.test.length, 1);
  assert.deepEqual(m.calls.test[0].cfg.ssh, { host: 'bastion', port: 22, user: 'fred', authMethod: 'key', keyPath: '/home/fred/.ssh/id_ed25519' });
  assert.equal(m.calls.test[0].ssh, 'phrase');
  assert.equal(f.status().cls, 'ok');
  // annulation du sélecteur : champ inchangé
  global.__openPick = undefined;
  $(f.d, 'pickKey').click(); await tick();
  assert.equal($(f.d, 'sshKey').value, '/home/fred/.ssh/id_ed25519');
});

test('agent SSH : aucun secret ni clé enregistrés', async () => {
  const m = manager();
  const f = open(m);
  f.type('host', 'localhost'); f.type('user', 'app');
  f.check('sshOn', true); f.choose('sshAuth', 'agent');
  f.type('sshHost', 'bastion'); f.type('sshUser', 'fred');
  $(f.d, 'saveBtn').click(); await tick(60);
  assert.deepEqual(m.calls.save[0].cfg.ssh, { host: 'bastion', port: 22, user: 'fred', authMethod: 'agent', keyPath: undefined });
});

test('sans tunnel : pas de clé ssh dans la configuration', async () => {
  const m = manager();
  const f = open(m);
  f.type('host', 'localhost'); f.type('user', 'app');
  f.check('sshOn', true); f.type('sshHost', 'x'); f.type('sshUser', 'y'); f.check('sshOn', false);
  $(f.d, 'saveBtn').click(); await tick(60);
  assert.equal(m.calls.save[0].cfg.ssh, undefined);
  assert.equal(m.calls.save[0].cfg.production, undefined);
  assert.equal(m.calls.save[0].cfg.readOnly, undefined);
});

test('modification : tunnel pré-rempli, secrets laissés vides = conservés', async () => {
  const m = manager();
  const existing = { id: 'c1', name: 'Prod', type: 'postgres', host: 'db', port: 5432, user: 'app', database: 'x',
    production: true, ssh: { host: 'bastion', port: 2222, user: 'fred', authMethod: 'key', keyPath: '~/.ssh/k' } };
  const f = open(m, existing);
  assert.equal($(f.d, 'sshOn').checked, true);
  assert.equal(f.hidden('sshBox'), false);
  assert.equal($(f.d, 'sshHost').value, 'bastion');
  assert.equal($(f.d, 'sshPort').value, '2222');
  assert.equal($(f.d, 'sshAuth').value, 'key');
  assert.equal($(f.d, 'sshKey').value, '~/.ssh/k');
  assert.equal(f.hidden('sshKeyRow'), false);
  assert.equal($(f.d, 'production').checked, true);
  assert.equal($(f.d, 'readOnly').checked, false);
  assert.match($(f.d, 'sshSecret').placeholder, /conserver/);

  // test : les secrets stockés sont utilisés
  $(f.d, 'testBtn').click(); await tick(60);
  assert.equal(m.calls.test[0].pw, 'mdp-stocké');
  assert.equal(m.calls.test[0].ssh, 'secret-ssh-stocké');
  // enregistrement : undefined = inchangé
  $(f.d, 'saveBtn').click(); await tick(60);
  assert.equal(m.calls.save[0].pw, undefined);
  assert.equal(m.calls.save[0].ssh, undefined);
  assert.equal(m.calls.save[0].cfg.id, 'c1');
  assert.equal(m.calls.save[0].cfg.production, true);
});

test('erreur du test de connexion : message affiché, boutons réactivés', async () => {
  const m = manager({ test: async () => { throw new Error('Authentification SSH refusée'); } });
  const f = open(m);
  f.type('host', 'localhost'); f.type('user', 'app');
  $(f.d, 'testBtn').click(); await tick(60);
  assert.equal(f.status().cls, 'ko');
  assert.match(f.status().text, /Authentification SSH refusée/);
  assert.equal($(f.d, 'testBtn').disabled, false);
});

test('SQLite : champ fichier, serveur et sécurité masqués, enregistrement en lecture seule', async () => {
  const mgr = manager();
  const f = open(mgr);
  f.d.querySelector('input[value=sqlite]').click();
  assert.equal(f.hidden('fileBox'), false);
  assert.equal(f.hidden('serverBox'), true);
  assert.equal(f.hidden('secBox'), true);

  $(f.d, 'saveBtn').click();                       // fichier manquant
  await tick();
  assert.equal(mgr.calls.save.length, 0);
  assert.match($(f.d, 'err-file').textContent, /fichier/);

  f.type('file', '/data/boutique.sqlite');
  assert.equal($(f.d, 'name').value, 'boutique.sqlite');
  $(f.d, 'saveBtn').click();
  await tick();
  assert.equal(mgr.calls.save.length, 1);
  const cfg = mgr.calls.save[0].cfg;
  assert.equal(cfg.type, 'sqlite');
  assert.equal(cfg.file, '/data/boutique.sqlite');
  assert.equal(cfg.readOnly, true);
  assert.equal(cfg.ssh, undefined);

  f.d.querySelector('input[value=mysql]').click();  // retour à un serveur
  assert.equal(f.hidden('serverBox'), false);
  assert.equal(f.hidden('fileBox'), true);
});

test('SQLite : bouton Parcourir → fichier choisi', async () => {
  const f = open(manager());
  f.d.querySelector('input[value=sqlite]').click();
  $(f.d, 'pickFile').click();
  await tick();
  assert.ok(f.sent.some((m) => m.type === 'pickFile'));
});

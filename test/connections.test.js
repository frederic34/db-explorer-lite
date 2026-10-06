// Connexions : groupes, export / import JSON, ~/.pgpass, ~/.pg_service.conf, ~/.my.cnf.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const imp = require('../.test-build/importers.js');
const { ConnectionManager } = require('../.test-build/manager.js');
const { ConnectionsTreeProvider, ConnectionNode, GroupNode } = require('../.test-build/tree.js');
const { openConnectionForm } = require('../.test-build/form.js');

const cfg = (over = {}) => ({ id: 'x', name: 'n', type: 'postgres', host: 'db.example', port: 5432, user: 'u', database: 'd', ...over });

test('~/.pgpass : champs, échappements, commentaires, jokers et lignes invalides', () => {
  const r = imp.parsePgpass([
    '# commentaire',
    '',
    'db.example:5432:shop:alice:s3cr\\:et',
    'localhost:5433:app:bob:a\\\\b',
    '*:5432:*:carol:x',
    'h:notaport:d:u:p',
    'trop:peu:de:champs',
    '  spaced.example:5432:d:u:pw  ',
  ].join('\n'));
  assert.equal(r.items.length, 3);
  assert.deepEqual(r.items[0].config, { name: 'alice@db.example/shop', type: 'postgres', host: 'db.example', port: 5432, user: 'alice', database: 'shop' });
  assert.equal(r.items[0].password, 's3cr:et');
  assert.equal(r.items[1].password, 'a\\b');
  assert.equal(r.items[2].config.host, 'spaced.example');
  assert.equal(r.skipped.length, 3);
  assert.ok(r.skipped.some((s) => /joker/.test(s)));
  assert.deepEqual(imp.parsePgpass('db:5432:d:u:mot:de:passe:avec:deux-points').items[0].password, 'mot:de:passe:avec:deux-points');
});

test('~/.my.cnf : [client] puis [mysql], guillemets, commentaires, socket', () => {
  const r = imp.parseMyCnf([
    '[client]', 'host = db.example   # serveur', 'port=3307', 'user="root"', "password='p#ss word'", 'default-character-set=utf8mb4',
    '[mysql]', 'database = shop', 'user = app',
    '[mysqldump]', 'user = ignored',
  ].join('\n'));
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0].config, { name: 'app@db.example/shop', type: 'mysql', host: 'db.example', port: 3307, user: 'app', database: 'shop', ssl: undefined });
  assert.equal(r.items[0].password, 'p#ss word');
  const d = imp.parseMyCnf('[client]\nuser=bob\n').items[0].config;
  assert.deepEqual([d.host, d.port], ['localhost', 3306]);
  assert.match(imp.parseMyCnf('[client]\nsocket=/var/run/mysqld/mysqld.sock\nuser=x').skipped[0], /socket/);
  assert.equal(imp.parseMyCnf('[mysqld]\nport=1').items.length, 0);
  assert.equal(imp.parseMyCnf('[client]\nuser=a\nhost=h\nport=99999').items.length, 0);
});

test('~/.pg_service.conf : services, sslmode, socket, champs manquants', () => {
  const r = imp.parsePgService([
    '# services', '[prod]', 'host=pg.example', 'port=5433', 'dbname=shop', 'user=ro', 'password=pw', 'sslmode=verify-full',
    '[local]', 'host=/var/run/postgresql', 'dbname=x', 'user=y',
    '[incomplet]', 'host=h',
    '[defaut]', 'dbname=d', 'user=u', 'sslmode=prefer',
  ].join('\n'));
  assert.deepEqual(r.items.map((i) => i.config.name), ['prod', 'defaut']);
  assert.equal(r.items[0].config.ssl, true);
  assert.equal(r.items[0].password, 'pw');
  assert.deepEqual([r.items[1].config.host, r.items[1].config.port, r.items[1].config.ssl], ['localhost', 5432, undefined]);
  assert.equal(r.skipped.length, 2);
});

test('export JSON : ni identifiant ni mot de passe ; aller-retour identique', () => {
  const all = [
    cfg({ id: 'a', name: 'Prod', group: 'Production', production: true, ssl: true, ssh: { host: 'bastion', port: 22, user: 'me', authMethod: 'key', keyPath: '~/.ssh/id' } }),
    cfg({ id: 'b', name: 'Local', type: 'mysql', port: 3306, database: undefined }),
    { id: 'c', name: 'Fichier', type: 'sqlite', host: '', port: 0, user: '', file: '/data/x.db', readOnly: true },
  ];
  const text = imp.serializeConnections(all);
  assert.ok(!/"id"|password|secret/i.test(text), 'aucun id ni secret dans le fichier');
  const back = imp.parseConnectionsFile(text);
  assert.equal(back.skipped.length, 0);
  const norm = (o) => JSON.parse(JSON.stringify(o));
  const expected = all.map(({ id, ...rest }) => norm(rest));
  // `ssl: false` et les valeurs par défaut peuvent être ajoutées à l'import : on vérifie l'inclusion
  back.items.forEach((it, i) => {
    const got = norm(it.config);
    for (const [k, v] of Object.entries(expected[i])) {
      assert.deepEqual(got[k], v, `champ ${k} de la connexion ${i}`);
    }
  });
  assert.equal(back.items[0].config.ssh.keyPath, '~/.ssh/id');
  assert.equal(back.items[0].password, undefined);
});

test('import JSON : entrées hostiles ou invalides rejetées, champs inconnus ignorés', () => {
  const hostile = JSON.stringify({ connections: [
    { name: 'ok', type: 'mysql', host: 'h', port: '3306', user: 'u', __proto__: { polluted: true }, extra: 'x', password: 'secret!' },
    { name: 'mauvais type', type: 'oracle', host: 'h', port: 1, user: 'u' },
    { name: 'port', type: 'mysql', host: 'h', port: 70000, user: 'u' },
    { name: 'pg sans base', type: 'postgres', host: 'h', port: 5432, user: 'u' },
    { type: 'mysql', host: 'h', port: 1, user: 'u' },
    { name: 'x'.repeat(500), type: 'mysql', host: 'h', port: 1, user: 'u' },
    { name: 'ssh', type: 'mysql', host: 'h', port: 1, user: 'u', ssh: { host: 'b', port: 22, user: 'm', authMethod: 'telepathie' } },
    { name: 'cle', type: 'mysql', host: 'h', port: 1, user: 'u', ssh: { host: 'b', port: 22, user: 'm', authMethod: 'key' } },
    { name: 'saut\nligne', type: 'mysql', host: 'h', port: 1, user: 'u' },
    'texte', null, 42, [],
    { name: 'sqlite', type: 'sqlite', file: '/x.db', host: 'ignoré', production: true },
  ] });
  const r = imp.parseConnectionsFile(hostile);
  assert.deepEqual(r.items.map((i) => i.config.name), ['ok', 'sqlite']);
  assert.equal(r.skipped.length, 12);
  const ok = r.items[0];
  assert.equal(ok.config.port, 3306);
  assert.equal(ok.password, undefined, 'un mot de passe présent dans le fichier est ignoré');
  assert.equal(ok.config.extra, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.keys(ok.config).includes('password'), false);
  assert.deepEqual(r.items[1].config, { name: 'sqlite', type: 'sqlite', host: '', port: 0, user: '', file: '/x.db', readOnly: true, group: undefined });
  assert.throws(() => imp.parseConnectionsFile('pas du json'), /JSON/);
  assert.throws(() => imp.parseConnectionsFile('{"autre":1}'), /Format non reconnu/);
  assert.throws(() => imp.parseConnectionsFile(JSON.stringify({ connections: new Array(1001).fill(1) })), /Trop de/);
});

test('doublons, type de fichier deviné, emplacements par défaut', () => {
  const existing = [cfg({ id: '1', host: 'DB.example' })];
  const plan = imp.planImport([
    { config: { name: 'a', type: 'postgres', host: 'db.example', port: 5432, user: 'u', database: 'd' } },
    { config: { name: 'b', type: 'postgres', host: 'autre', port: 5432, user: 'u', database: 'd' }, password: 'p' },
    { config: { name: 'c', type: 'postgres', host: 'autre', port: 5432, user: 'u', database: 'd' } },
  ], existing);
  assert.deepEqual(plan.map((p) => p.duplicate), [true, false, true], 'existante, nouvelle, répétée dans le fichier');
  assert.ok(plan[1].detail.includes('mot de passe du fichier') && plan[0].detail.includes('déjà présente'));
  assert.equal(imp.connectionKey({ type: 'sqlite', file: '/a.db', host: '', port: 0, user: '' }), 'sqlite|/a.db');

  assert.equal(imp.guessSource('/h/.pgpass', ''), 'pgpass');
  assert.equal(imp.guessSource('C:\\x\\pgpass.conf', ''), 'pgpass');
  assert.equal(imp.guessSource('/h/.pg_service.conf', ''), 'pgservice');
  assert.equal(imp.guessSource('/h/.my.cnf', ''), 'mycnf');
  assert.equal(imp.guessSource('/h/export.json', ''), 'json');
  assert.equal(imp.guessSource('/h/inconnu', '{"connections":[]}'), 'json');
  assert.equal(imp.guessSource('/h/inconnu', 'h:5432:d:u:p'), 'pgpass');
  assert.equal(imp.guessSource('/h/inconnu', 'rien de connu'), undefined);

  const unix = imp.defaultSourcePaths({}, '/home/me', 'linux');
  assert.deepEqual(unix.map((s) => s.path), ['/home/me/.pgpass', '/home/me/.pg_service.conf', '/home/me/.my.cnf']);
  assert.equal(imp.defaultSourcePaths({ PGPASSFILE: '/x/pw', PGSERVICEFILE: '/x/svc' }, '/h', 'linux')[0].path, '/x/pw');
  assert.equal(imp.defaultSourcePaths({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me', 'win32')[0].path, 'C:\\Users\\me\\AppData\\Roaming\\postgresql\\pgpass.conf');
});

function fakeCtx() {
  const state = {}, secrets = {};
  return { state, secrets, ctx: {
    globalState: { get: (k, d) => (k in state ? state[k] : d), update: async (k, v) => { state[k] = v; } },
    secrets: { get: async (k) => secrets[k], store: async (k, v) => { secrets[k] = v; }, delete: async (k) => { delete secrets[k]; } },
  } };
}

test('gestionnaire : groupes (ranger, renommer, fusionner, supprimer) et mots de passe importés', async () => {
  const { ctx, secrets } = fakeCtx();
  const m = new ConnectionManager(ctx);
  let changes = 0;
  m.onDidChange(() => changes++);
  await m.save(cfg({ id: 'a', name: 'A' }), 'pw-a');
  await m.save(cfg({ id: 'b', name: 'B', host: 'h2' }), 'pw-b');
  await m.save(cfg({ id: 'c', name: 'C', host: 'h3', group: 'Clients' }), undefined);
  assert.deepEqual(m.groups(), ['Clients']);
  assert.equal(secrets['dbExplorer.password.c'], undefined, 'pas de mot de passe fourni : rien enregistré');
  assert.equal(secrets['dbExplorer.password.a'], 'pw-a');

  await m.setGroup(['a', 'b'], '  Production ');
  assert.deepEqual(m.groups(), ['Clients', 'Production']);
  assert.equal(m.get('a').group, 'Production');
  await m.renameGroup('Production', 'Prod');
  assert.deepEqual(m.list().map((c) => c.group), ['Prod', 'Prod', 'Clients']);
  await m.renameGroup('Clients', 'Prod');   // fusion
  assert.deepEqual(m.groups(), ['Prod']);
  await assert.rejects(m.renameGroup('Prod', '  '), /vide/);
  await m.removeGroup('Prod');
  assert.deepEqual(m.groups(), []);
  assert.equal(m.list().length, 3, 'les connexions sont conservées');
  await m.setGroup(['a'], undefined);
  assert.equal(m.get('a').group, undefined);
  assert.ok(changes >= 6);
});

test('arbre : groupes en tête, connexions hors groupe ensuite, rafraîchissement ciblé', async () => {
  const list = [cfg({ id: 'a', name: 'Alpha' }), cfg({ id: 'b', name: 'Beta', group: 'Zèbre' }), cfg({ id: 'c', name: 'Gamma', group: 'Abeille' }), cfg({ id: 'd', name: 'Delta', group: 'Zèbre' })];
  const tree = new ConnectionsTreeProvider({ list: () => list, onDidChange: () => ({ dispose() {} }) });
  const fired = [];
  tree.onDidChangeTreeData((e) => fired.push(e));
  const root = await tree.getChildren();
  assert.deepEqual(root.map((n) => n.label), ['Abeille', 'Zèbre', 'Alpha']);
  assert.ok(root[0] instanceof GroupNode && root[2] instanceof ConnectionNode);
  assert.deepEqual([root[0].description, root[1].description], ['1', '2']);
  assert.equal(root[0].contextValue, 'group');
  const kids = await tree.getChildren(root[1]);
  assert.deepEqual(kids.map((n) => n.label), ['Beta', 'Delta']);
  tree.refreshConnection('d');
  assert.equal(fired.pop(), kids[1], 'un nœud rangé dans un groupe est rafraîchi seul');
});

test('formulaire : champ groupe avec suggestions, enregistré dans la connexion', async () => {
  const saved = [];
  const mgr = { groups: () => ['Clients', 'Production'], getPassword: async () => '', getSshSecret: async () => '', test: async () => {}, save: async (c) => { saved.push(c); } };
  const open = () => {
    global.__vsPanels.forEach((p) => { if (!p.disposed) { p.dispose(); } });
    const before = global.__vsPanels.length;
    openConnectionForm(mgr, cfg({ id: 'e', group: 'Clients' }));
    const panel = global.__vsPanels[before];
    const dom = new JSDOM(panel.html, { runScripts: 'dangerously', beforeParse(w) { global.__vsWin = w; w.acquireVsCodeApi = () => ({ postMessage: (m) => panel.handlers.forEach((h) => h(m)) }); } });
    return dom.window.document;
  };
  let d = open();
  assert.equal(d.getElementById('group').value, 'Clients');
  assert.deepEqual([...d.querySelectorAll('#groupList option')].map((o) => o.value), ['Clients', 'Production']);
  d.getElementById('group').value = '  Production ';
  d.getElementById('saveBtn').click();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(saved[0].group, 'Production');
  d = open();
  d.getElementById('group').value = '';
  d.getElementById('saveBtn').click();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(saved[1].group, undefined);
});

// Rafraîchissement après un DDL : détection (sqlGuard) et rafraîchissement ciblé de l'arbre.
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, assessRun } = require('../.test-build/sqlGuard.js');
const { ConnectionsTreeProvider, ConnectionNode } = require('../.test-build/tree.js');

test('instructions qui modifient la structure', () => {
  const ddl = (sql, t = 'postgres') => analyze(sql, t).map((s) => s.ddl);
  assert.deepEqual(ddl('CREATE TABLE t (a int); DROP TABLE u; ALTER TABLE v ADD c int; RENAME TABLE a TO b'), [true, true, true, true]);
  assert.deepEqual(ddl("COMMENT ON TABLE t IS 'x'"), [true]);
  assert.deepEqual(ddl("create index i on t(a); -- commentaire\n  /* c */ Drop view v", 'mysql'), [true, true]);
  assert.deepEqual(ddl("SELECT 'CREATE TABLE x'; INSERT INTO t VALUES (1); UPDATE t SET a = 1 WHERE b = 2; DELETE FROM t WHERE a = 1; TRUNCATE t; SET search_path = x; BEGIN; COMMIT"),
    [false, false, false, false, false, false, false, false]);
  assert.deepEqual(ddl('WITH x AS (SELECT 1) SELECT * FROM x'), [false]);
  const v = assessRun('CREATE TABLE t (a int)', 'postgres', { confirmDangerous: true, confirmProduction: true });
  assert.equal(v.statements[0].ddl, true);
});

test('arbre : ne rafraîchir que la connexion concernée', async () => {
  const cfgs = [{ id: 'a', name: 'A', type: 'postgres', host: 'h', port: 1, user: 'u' }, { id: 'b', name: 'B', type: 'mysql', host: 'h', port: 1, user: 'u' }];
  const mgr = { list: () => cfgs, onDidChange: () => ({ dispose() {} }) };
  const tree = new ConnectionsTreeProvider(mgr);
  const fired = [];
  tree.onDidChangeTreeData((e) => fired.push(e));

  const roots = await tree.getChildren();
  assert.equal(roots.length, 2);
  assert.ok(roots[0] instanceof ConnectionNode);

  tree.refreshConnection('b');
  assert.equal(fired.pop(), roots[1], 'le nœud de la connexion B, pas toute la vue');
  tree.refreshConnection('a');
  assert.equal(fired.pop(), roots[0]);
  tree.refreshConnection('inconnue');
  assert.equal(fired.pop(), undefined, 'connexion inconnue : rafraîchissement complet');
  tree.refresh();
  assert.equal(fired.pop(), undefined);

  // après un nouvel affichage de la racine, c'est le nouveau nœud qui est visé
  const again = await tree.getChildren();
  tree.refreshConnection('a');
  assert.equal(fired.pop(), again[0]);
});

test('arbre : rubriques Tables / Vues / Fonctions / Procédures / Événements, vides masquées', async () => {
  const cfg = { id: 'a', name: 'A', type: 'mysql', host: 'h', port: 1, user: 'u' };
  const driver = {
    listTables: async () => [{ name: 't1', isView: false, rows: 5, approx: true }, { name: 't2', isView: false }, { name: 'v1', isView: true }],
    listRoutines: async () => [{ name: 'f', kind: 'function', id: 'f' }, { name: 'p', kind: 'procedure', id: 'p' }],
    listEvents: async () => { throw new Error('droits insuffisants'); },
  };
  const mgr = { list: () => [cfg], onDidChange: () => ({ dispose() {} }), getDriver: async () => driver };
  const tree = new ConnectionsTreeProvider(mgr);
  const [conn] = await tree.getChildren();
  const [container] = await tree.getChildren(conn);
  // (le conteneur est celui de la base ; on le fabrique directement)
  const { ContainerNode } = require('../.test-build/tree.js');
  const cats = await tree.getChildren(new ContainerNode(cfg, 'db'));
  assert.deepEqual(cats.map((c) => [c.kind, c.description]), [['tables', '2'], ['views', '1'], ['functions', '1'], ['procedures', '1']], 'événements en erreur : rubrique absente, le reste s\'affiche');
  assert.deepEqual((await tree.getChildren(cats[0])).map((n) => n.label), ['t1', 't2']);
  assert.deepEqual((await tree.getChildren(cats[1])).map((n) => n.label), ['v1']);
  const fn = (await tree.getChildren(cats[2]))[0];
  assert.equal(fn.contextValue, 'function');
  assert.equal(fn.command.command, 'dbExplorer.showDefinition');
  assert.equal((await tree.getChildren(cats[3]))[0].contextValue, 'procedure');
  void container;
});

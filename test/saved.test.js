// Paramètres nommés et requêtes enregistrées (parties pures).
const test = require('node:test');
const assert = require('node:assert/strict');
const { findParams, paramNames, paramLiteral, substituteParams } = require('../.test-build/queryParams.js');
const { SavedQueries } = require('../.test-build/savedQueries.js');

test('findParams : ignore chaînes, identifiants, commentaires, $$, conversions ::, a:b', () => {
  const sql = "SELECT ':a', \":b\", x::int, a[1:2], '12:30', :p1 /* :c */ -- :d\n, $$ :e $$, $t$ :f $t$ FROM t WHERE k = :p1 AND n > :n2 AND `:q` = 1";
  assert.deepEqual(paramNames(sql, 'postgres'), ['p1', 'n2']);
  const refs = findParams(sql, 'postgres');
  assert.equal(refs.length, 3);
  assert.equal(sql.slice(refs[0].start, refs[0].end), ':p1');
  assert.deepEqual(paramNames('SELECT @v := 1, :x', 'mysql'), ['x']);
  assert.deepEqual(paramNames("SELECT 'it\\':a', :y # :z\n", 'mysql'), ['y'], 'échappement MySQL et commentaire #');
  assert.deepEqual(paramNames('SELECT 1', 'sqlite'), []);
  assert.deepEqual(paramNames('SELECT :a:b', 'postgres'), ['a'], 'a:b : le second « : » suit un mot');
});

test('paramLiteral : nombre, null, chaînes échappées (MySQL : antislash)', () => {
  assert.equal(paramLiteral('42', 'postgres'), '42');
  assert.equal(paramLiteral('-3.5', 'postgres'), '-3.5');
  assert.equal(paramLiteral('007', 'postgres'), "'007'");
  assert.equal(paramLiteral('NULL', 'postgres'), 'NULL');
  assert.equal(paramLiteral("O'Brien", 'postgres'), "'O''Brien'");
  assert.equal(paramLiteral("a\\' OR 1=1 --", 'mysql'), "'a\\\\'' OR 1=1 --'");
  assert.equal(paramLiteral('', 'sqlite'), "''");
  assert.equal(paramLiteral('1; DROP TABLE t', 'postgres'), "'1; DROP TABLE t'");
});

test('substituteParams : toutes les occurrences, le reste intact', () => {
  const sql = "SELECT ':a' AS s, x::int FROM t WHERE a = :a AND b = :b OR c = :a";
  assert.equal(substituteParams(sql, 'postgres', { a: '5', b: "x'y" }), "SELECT ':a' AS s, x::int FROM t WHERE a = 5 AND b = 'x''y' OR c = 5");
  assert.equal(substituteParams('SELECT 1', 'postgres', {}), 'SELECT 1');
});

function mem() {
  const data = {};
  return { get: (k, f) => (k in data ? data[k] : f), update: async (k, v) => { data[k] = v; } };
}

test('SavedQueries : ajout, dossiers, renommage / fusion, suppression', async () => {
  let n = 0;
  const q = new SavedQueries(mem(), () => 'id' + ++n);
  let fired = 0;
  q.onDidChange(() => fired++);
  const a = await q.add({ name: ' Clients actifs ', sql: ' SELECT 1 ', folder: 'Ventes', connectionId: 'c1' });
  await q.add({ name: 'Stock', sql: 'SELECT 2', folder: 'Achats' });
  await q.add({ name: 'Libre', sql: 'SELECT 3' });
  assert.equal(a.name, 'Clients actifs'); assert.equal(a.sql, 'SELECT 1');
  assert.deepEqual(q.folders(), ['Achats', 'Ventes']);
  await assert.rejects(q.add({ name: ' ', sql: 'x' }));
  await assert.rejects(q.add({ name: 'x', sql: ' ' }));
  await q.renameFolder('Achats', 'Ventes');
  assert.deepEqual(q.folders(), ['Ventes'], 'fusion de dossiers');
  await assert.rejects(q.renameFolder('Ventes', '  '));
  await q.update('id3', { folder: 'Ventes', name: ' ' });
  assert.equal(q.get('id3').name, 'Libre', 'nom vide ignoré');
  await q.removeFolder('Ventes');
  assert.deepEqual(q.folders(), []);
  assert.equal(q.list().length, 3, 'requêtes conservées');
  await q.remove('id1');
  assert.deepEqual(q.list().map((x) => x.id), ['id2', 'id3']);
  assert.ok(fired >= 7);
});

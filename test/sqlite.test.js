// SQLite (sql.js) : pilote, pagination / tri / filtre, clés étrangères, lecture seule, rechargement.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');
const { createDriver, SQLITE_MAX_BYTES } = require('../.test-build/drivers.js');
const { buildPageQuery, buildCountQuery } = require('../.test-build/browse.js');
const { assessRun, analyze } = require('../.test-build/sqlGuard.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-sqlite-'));
const file = path.join(dir, 'shop.db');
const opts = { maxRows: () => 5000, showSystem: () => false };
const cfg = (over = {}) => ({ id: 'x', name: 'shop', type: 'sqlite', host: '', port: 0, user: '', file, readOnly: true, ...over });

async function makeDb(sql) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec(sql);
  fs.writeFileSync(file, Buffer.from(db.export()));
  db.close();
}

const SCHEMA = `
  CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT, photo BLOB);
  CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), total REAL DEFAULT 0,
                       tax REAL GENERATED ALWAYS AS (total * 0.2) VIRTUAL);
  CREATE TABLE lines (order_id INTEGER, n INTEGER, label TEXT, PRIMARY KEY (order_id, n),
                      FOREIGN KEY (order_id) REFERENCES orders);
  CREATE VIEW big AS SELECT * FROM orders WHERE total > 10;
  INSERT INTO customers (id, name, note, photo) VALUES (1,'Alice','100% bio',x'0102'),(2,'Bob',NULL,NULL),(3,'Chloé','a_b',NULL);
  INSERT INTO orders (id, customer_id, total) VALUES (1,1,5),(2,1,20),(3,2,30);
  INSERT INTO lines VALUES (1,1,'x'),(1,2,'y');
`;

test.before(() => makeDb(SCHEMA));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('conteneurs, tables et vues (tables internes exclues)', async () => {
  const d = createDriver(cfg(), '', opts);
  assert.deepEqual(await d.listContainers(), ['main']);
  const t = await d.listTables('main');
  assert.deepEqual(t.map((x) => [x.name, x.isView]), [['big', true], ['customers', false], ['lines', false], ['orders', false]]);
  await d.dispose();
});

test('colonnes : clé primaire, défaut, générée, clés étrangères', async () => {
  const d = createDriver(cfg(), '', opts);
  const cu = await d.listColumns('main', 'customers');
  assert.deepEqual(cu.map((c) => [c.name, c.primaryKey, c.nullable, c.hasDefault]),
    [['id', true, false, true], ['name', false, false, false], ['note', false, true, false], ['photo', false, true, false]]);
  const o = await d.listColumns('main', 'orders');
  assert.deepEqual(o.find((c) => c.name === 'customer_id').references, { container: 'main', table: 'customers', column: 'id' });
  assert.equal(o.find((c) => c.name === 'tax').generated, true);
  assert.equal(o.find((c) => c.name === 'total').hasDefault, true);
  const l = await d.listColumns('main', 'lines');
  assert.equal(l.find((c) => c.name === 'order_id').references?.column, 'id', 'REFERENCES sans colonne → clé primaire cible');
  assert.equal(l.find((c) => c.name === 'n').hasDefault, false, 'clé composite : pas de rowid');
  await d.dispose();
});

test('requête, paramètres, valeurs binaires et NULL', async () => {
  const d = createDriver(cfg(), '', opts);
  const r = await d.query('SELECT id, note, photo FROM customers ORDER BY id');
  assert.deepEqual(r.columns, ['id', 'note', 'photo']);
  assert.deepEqual(r.rows, [['1', '100% bio', '0x0102'], ['2', null, null], ['3', 'a_b', null]]);
  const p = await d.query('SELECT name FROM customers WHERE id = ?', [2]);
  assert.deepEqual(p.rows, [['Bob']]);
  await assert.rejects(d.query('SELEC 1'), /syntax error/);
  await d.dispose();
});

test('pagination, tri, filtre (jokers neutralisés) et navigation FK', async () => {
  const d = createDriver(cfg(), '', opts);
  const columns = await d.listColumns('main', 'customers');
  const base = { dbType: 'sqlite', container: 'main', table: 'customers', columns, pageSize: 2, offset: 0 };
  let q = buildPageQuery(base);
  let r = await d.query(q.sql, q.params);
  assert.equal(r.rows.length, 3, 'page + 1 ligne pour détecter la suivante');

  q = buildPageQuery({ ...base, sort: { column: 'name', dir: 'desc' } });
  r = await d.query(q.sql, q.params);
  assert.deepEqual(r.rows.map((x) => x[1]), ['Chloé', 'Bob', 'Alice']);

  for (const [term, expected] of [['100%', ['Alice']], ['a_b', ['Chloé']], ['ALICE', ['Alice']], ['zzz', []]]) {
    q = buildPageQuery({ ...base, pageSize: 10, filter: term });
    r = await d.query(q.sql, q.params);
    assert.deepEqual(r.rows.map((x) => x[1]), expected, term);
  }
  const c = buildCountQuery({ ...base, filter: 'b' });
  assert.deepEqual((await d.query(c.sql, c.params)).rows, [['3']]); // Alice (bio), Bob, Chloé (a_b)

  const ocols = await d.listColumns('main', 'orders');
  q = buildPageQuery({ ...base, table: 'orders', columns: ocols, pageSize: 10, where: { column: 'customer_id', value: '1' } });
  r = await d.query(q.sql, q.params);
  assert.equal(r.rows.length, 2);
  await d.dispose();
});

test('lecture seule : écritures refusées par le pilote et par le garde-fou', async () => {
  const d = createDriver(cfg(), '', opts);
  await assert.rejects(d.query('DELETE FROM customers'), /readonly|read-only|lecture/i);
  await assert.rejects(d.executeBatch([{ sql: 'DELETE FROM customers', params: [] }]), /lecture seule/);
  await assert.rejects(d.insertRow('INSERT INTO customers (name) VALUES (?)', ['z']), /lecture seule/);
  assert.equal((await d.query('SELECT count(*) FROM customers')).rows[0][0], '3');
  await d.dispose();

  const blocked = (sql) => assessRun(sql, 'sqlite', { readOnly: true, confirmDangerous: true, confirmProduction: true }).blocked;
  assert.ok(blocked('UPDATE customers SET name = 1'));
  assert.ok(blocked('PRAGMA query_only = OFF'));
  assert.ok(blocked('ATTACH DATABASE "x" AS y'));
  assert.ok(blocked('VACUUM'));
  assert.equal(blocked('SELECT 1'), undefined);
  assert.equal(blocked('PRAGMA table_info(customers)'), undefined);
  assert.equal(blocked('EXPLAIN QUERY PLAN SELECT * FROM customers'), undefined);
  assert.deepEqual(analyze('PRAGMA foreign_key_list(orders); SELECT 1', 'sqlite').map((s) => s.kind), ['read', 'read']);
});

test('le fichier modifié est relu ; fichier absent, invalide ou trop gros : messages clairs', async () => {
  const d = createDriver(cfg(), '', opts);
  assert.equal((await d.query('SELECT count(*) FROM customers')).rows[0][0], '3');
  await new Promise((r) => setTimeout(r, 20));
  await makeDb(SCHEMA + "INSERT INTO customers (id, name) VALUES (4, 'Dan');");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.equal((await d.query('SELECT count(*) FROM customers')).rows[0][0], '4');
  await d.dispose();

  await assert.rejects(createDriver(cfg({ file: path.join(dir, 'absent.db') }), '', opts).listContainers(), /introuvable/);
  const junk = path.join(dir, 'junk.db');
  fs.writeFileSync(junk, 'ceci n\'est pas une base SQLite, loin de là'.repeat(10));
  await assert.rejects(createDriver(cfg({ file: junk }), '', opts).listContainers(), /pas une base SQLite/);
  await assert.rejects(createDriver(cfg({ file: dir }), '', opts).listContainers(), /pas un fichier/);
  assert.equal(SQLITE_MAX_BYTES, 300 * 1024 * 1024);
});

test('maxRows tronque le résultat', async () => {
  const d = createDriver(cfg(), '', { ...opts, maxRows: () => 2 });
  const r = await d.query('SELECT * FROM customers');
  assert.equal(r.rows.length, 2);
  assert.equal(r.rowCount, 4);
  assert.equal(r.truncated, true);
  await d.dispose();
});

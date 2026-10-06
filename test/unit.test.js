// Tests unitaires des générateurs SQL et de la logique d'édition (sans base de données).
const test = require('node:test');
const assert = require('node:assert/strict');
const { likePattern, buildPageQuery, buildCountQuery } = require('../.test-build/browse.js');
const {
  buildDeletes, buildInsert, buildSelectRow, buildUpdate, isEditableType, isBinaryLike, planEditing,
} = require('../.test-build/editing.js');
const { quoteIdent } = require('../.test-build/util.js');

const col = (name, type = 'text', extra = {}) => ({
  name, type, nullable: true, primaryKey: false, hasDefault: false, generated: false, ...extra,
});
const cols = [col('id', 'integer', { primaryKey: true, nullable: false }), col('nom'), col('bin', 'bytea')];
const mysqlCols = [col('id', 'int', { primaryKey: true }), col('nom', 'varchar(10)'), col('bin', 'blob')];
const base = { container: 'shop', table: 't', pageSize: 100, offset: 0 };

test('quoteIdent neutralise les guillemets', () => {
  assert.equal(quoteIdent('postgres', 'a"b'), '"a""b"');
  assert.equal(quoteIdent('mysql', 'a`b'), '`a``b`');
});

test('likePattern : %, _ et ! saisis sont littéraux', () => {
  assert.equal(likePattern('abc'), '%abc%');
  assert.equal(likePattern('50%_!'), '%50!%!_!!%');
});

test('page PostgreSQL : ordre par clé primaire, une ligne de plus pour détecter la suite', () => {
  const q = buildPageQuery({ ...base, dbType: 'postgres', columns: cols, offset: 200 });
  assert.equal(q.sql, 'SELECT * FROM "shop"."t" ORDER BY "id" LIMIT 101 OFFSET 200');
  assert.deepEqual(q.params, []);
});

test('tri : la clé primaire départage, sans doublon si on trie sur elle', () => {
  const s = buildPageQuery({ ...base, dbType: 'postgres', columns: cols, sort: { column: 'nom', dir: 'desc' } });
  assert.match(s.sql, /ORDER BY "nom" DESC, "id" LIMIT/);
  const p = buildPageQuery({ ...base, dbType: 'postgres', columns: cols, sort: { column: 'id', dir: 'asc' } });
  assert.match(p.sql, /ORDER BY "id" ASC LIMIT/);
});

test('sans clé primaire : pas d\'ORDER BY inventé', () => {
  const q = buildPageQuery({ ...base, dbType: 'postgres', columns: [col('a'), col('b')] });
  assert.ok(!q.sql.includes('ORDER BY'));
});

test('filtre PostgreSQL : un seul paramètre, colonnes binaires exclues, échappement LIKE', () => {
  const q = buildPageQuery({ ...base, dbType: 'postgres', columns: cols, filter: '  a%b ' });
  assert.match(q.sql, /WHERE "id"::text ILIKE \$1 ESCAPE '!' OR "nom"::text ILIKE \$1 ESCAPE '!' ORDER BY/);
  assert.ok(!q.sql.includes('"bin"'));
  assert.deepEqual(q.params, ['%a!%b%']);
});

test('filtre MySQL : un paramètre par colonne, colonnes binaires exclues', () => {
  const q = buildPageQuery({ ...base, dbType: 'mysql', columns: mysqlCols, filter: 'x' });
  assert.match(q.sql, /WHERE CAST\(`id` AS CHAR\) LIKE \? ESCAPE '!' OR CAST\(`nom` AS CHAR\) LIKE \? ESCAPE '!'/);
  assert.ok(!q.sql.includes('`bin`'));
  assert.deepEqual(q.params, ['%x%', '%x%']);
});

test('filtre sur une table 100 % binaire : aucun résultat plutôt qu\'une erreur', () => {
  const q = buildPageQuery({ ...base, dbType: 'postgres', columns: [col('b', 'bytea')], filter: 'x' });
  assert.match(q.sql, /WHERE 1 = 0/);
});

test('filtre hostile : jamais dans le SQL, uniquement en paramètre', () => {
  const evil = "x'; DROP TABLE t; --";
  const q = buildPageQuery({ ...base, dbType: 'postgres', columns: cols, filter: evil });
  assert.ok(!q.sql.includes('DROP'));
  assert.ok(q.params[0].includes('DROP'));
});

test('taille et décalage entiers et bornés', () => {
  const q = buildPageQuery({ ...base, dbType: 'mysql', columns: mysqlCols, pageSize: 0, offset: -5 });
  assert.match(q.sql, /LIMIT 2 OFFSET 0$/);
});

test('COUNT avec le même filtre que la page', () => {
  const q = buildCountQuery({ ...base, dbType: 'postgres', columns: cols, filter: 'z' });
  assert.match(q.sql, /^SELECT COUNT\(\*\) FROM "shop"."t" WHERE /);
  assert.ok(!q.sql.includes('ORDER BY') && !q.sql.includes('LIMIT'));
});

test('isEditableType / isBinaryLike', () => {
  assert.equal(isEditableType('postgres', 'integer'), true);
  assert.equal(isEditableType('postgres', 'ARRAY'), false);
  assert.equal(isEditableType('postgres', 'interval'), false);
  assert.equal(isEditableType('mysql', 'varchar(20)'), true);
  assert.equal(isEditableType('mysql', 'blob'), false);
  assert.equal(isEditableType('mysql', 'geometry'), false);
  assert.equal(isBinaryLike('postgres', 'bytea'), true);
  assert.equal(isBinaryLike('mysql', 'longblob'), true);
  assert.equal(isBinaryLike('mysql', 'text'), false);
});

test('planEditing : clé primaire, colonnes générées, raisons de refus', () => {
  const table = [
    col('id', 'integer', { primaryKey: true, nullable: false, hasDefault: true }),
    col('a', 'integer', { nullable: false }),
    col('g', 'integer', { generated: true }),
    col('t', 'ARRAY'),
  ];
  const r = planEditing('postgres', ['id', 'a', 'g', 't'], table);
  assert.ok('plan' in r);
  assert.deepEqual(r.plan.pk, [0]);
  assert.deepEqual(r.plan.editable, [false, true, false, false]);
  assert.deepEqual(r.plan.insertable, [true, true, false, false]);
  assert.deepEqual(r.plan.hasDefault, [true, false, false, false]);
  assert.match(planEditing('postgres', ['a'], table).reason, /ne correspondent pas/);
  assert.match(planEditing('postgres', ['a'], [col('a')]).reason, /clé primaire/);
});

test('UPDATE : paramètres liés dans l\'ordre, une seule ligne attendue', () => {
  const pg = buildUpdate('postgres', 's', 't', ['id', 'a', 'b'], [1, 2], ['x', null], [0], ['7']);
  assert.equal(pg.sql, 'UPDATE "s"."t" SET "a" = $1, "b" = $2 WHERE "id" = $3');
  assert.deepEqual(pg.params, ['x', null, '7']);
  assert.equal(pg.expect, 1);
  const my = buildUpdate('mysql', 's', 't', ['id', 'a'], [1], ['x'], [0], ['7']);
  assert.equal(my.sql, 'UPDATE `s`.`t` SET `a` = ? WHERE `id` = ?');
});

test('INSERT : colonnes choisies, RETURNING sous PostgreSQL, valeurs par défaut', () => {
  assert.deepEqual(buildInsert('postgres', 's', 't', ['id', 'a'], [1], ['x']),
    { sql: 'INSERT INTO "s"."t" ("a") VALUES ($1) RETURNING *', params: ['x'] });
  assert.equal(buildInsert('mysql', 's', 't', ['id'], [], []).sql, 'INSERT INTO `s`.`t` () VALUES ()');
  assert.equal(buildInsert('postgres', 's', 't', ['id'], [], []).sql, 'INSERT INTO "s"."t" DEFAULT VALUES RETURNING *');
});

test('SELECT d\'une ligne par clé (relecture)', () => {
  const q = buildSelectRow('postgres', 's', 't', ['a', 'b'], ['1', '2']);
  assert.equal(q.sql, 'SELECT * FROM "s"."t" WHERE "a" = $1 AND "b" = $2');
});

test('DELETE : clé simple, IN, et découpage par lots', () => {
  const rows = Array.from({ length: 1200 }, (_, i) => [String(i)]);
  const st = buildDeletes('postgres', 's', 't', ['id'], rows);
  assert.equal(st.length, 3);
  assert.deepEqual(st.map((s) => s.expect), [500, 500, 200]);
  assert.match(st[0].sql, /^DELETE FROM "s"."t" WHERE "id" IN \(\$1, \$2,/);
  assert.equal(st[0].params.length, 500);
});

test('DELETE : clé composite', () => {
  const [s] = buildDeletes('mysql', 's', 't', ['a', 'b'], [['1', '2'], ['3', '4']]);
  assert.equal(s.sql, 'DELETE FROM `s`.`t` WHERE (`a`, `b`) IN ((?, ?), (?, ?))');
  assert.deepEqual(s.params, ['1', '2', '3', '4']);
  assert.equal(s.expect, 2);
});

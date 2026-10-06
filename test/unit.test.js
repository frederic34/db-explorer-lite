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

// ---------------------------------------------------------------- garde-fous SQL
const { parseStatements, splitStatements, analyze, assessRun } = require('../.test-build/sqlGuard.js');
const kinds = (sql, db = 'postgres') => analyze(sql, db).map((s) => s.kind);
const dangers = (sql, db = 'postgres') => analyze(sql, db).map((s) => s.danger).filter(Boolean);
const opts = { confirmDangerous: true, confirmProduction: true };

test('découpage : ; dans chaînes, commentaires, identifiants et dollars', () => {
  assert.deepEqual(splitStatements("select 'a;b'; select 2", 'postgres'), ["select 'a;b'", 'select 2']);
  assert.deepEqual(splitStatements('select 1; -- fin; ici\nselect 2;', 'postgres'), ['select 1', '-- fin; ici\nselect 2']);
  assert.deepEqual(splitStatements('select /* a; b */ 1; select 2', 'mysql'), ['select /* a; b */ 1', 'select 2']);
  assert.deepEqual(splitStatements('select "a;b" from t; select 2', 'postgres'), ['select "a;b" from t', 'select 2']);
  assert.deepEqual(splitStatements('select `a;b` from t; select 2', 'mysql'), ['select `a;b` from t', 'select 2']);
  assert.deepEqual(splitStatements("select 'it''s;'; select 2", 'postgres'), ["select 'it''s;'", 'select 2']);
  assert.deepEqual(splitStatements("select 'a\\';b'; select 2", 'mysql'), ["select 'a\\';b'", 'select 2']);
  assert.equal(splitStatements("select 'a\\'; select 2", 'postgres').length, 2, 'PostgreSQL : antislash littéral');
  assert.deepEqual(
    splitStatements('create function f() returns int as $$ begin; select 1; end $$ language sql; select 2', 'postgres'),
    ['create function f() returns int as $$ begin; select 1; end $$ language sql', 'select 2']);
  assert.deepEqual(splitStatements('select $t$a;b$t$; select 2', 'postgres'), ['select $t$a;b$t$', 'select 2']);
  assert.deepEqual(splitStatements('select 1;;; ;', 'postgres'), ['select 1']);
  assert.deepEqual(splitStatements('select 1 # note; x\n; select 2', 'mysql'), ['select 1 # note; x', 'select 2']);
  assert.deepEqual(splitStatements('', 'mysql'), []);
  assert.deepEqual(splitStatements('-- rien', 'mysql'), []);
});

test('classification : lectures, session, écritures', () => {
  assert.deepEqual(kinds('SELECT 1; show tables; describe t; explain select 1; values (1); table t'),
    Array(6).fill('read'));
  assert.deepEqual(kinds('SELECT * FROM t FOR UPDATE'), ['read']);
  assert.deepEqual(kinds('(select 1) union (select 2)'), ['read']);
  assert.deepEqual(kinds('WITH x AS (SELECT 1) SELECT * FROM x'), ['read']);
  assert.deepEqual(kinds('WITH x AS (DELETE FROM t WHERE a=1 RETURNING *) SELECT * FROM x'), ['write']);
  assert.deepEqual(kinds('SELECT * INTO nouvelle FROM t'), ['write']);
  assert.deepEqual(kinds('EXPLAIN ANALYZE DELETE FROM t WHERE a = 1'), ['write']);
  assert.deepEqual(kinds('INSERT INTO t VALUES (1); UPDATE t SET a=1 WHERE b=2; DELETE FROM t WHERE a=1; DROP TABLE t; CREATE TABLE x(a int); CALL p(); COPY t TO STDOUT'),
    Array(7).fill('write'));
  assert.deepEqual(kinds("SET search_path = a; BEGIN; COMMIT; ROLLBACK"), ['session', 'session', 'session', 'session']);
  assert.deepEqual(kinds('SET default_transaction_read_only = off; SET SESSION TRANSACTION READ WRITE; START TRANSACTION READ WRITE'),
    ['write', 'write', 'write'], 'on ne laisse pas lever la lecture seule');
  assert.deepEqual(kinds("select 'DELETE FROM t' as x, 'a;b' -- drop table t\n"), ['read'], 'mots dans chaînes et commentaires ignorés');
  assert.deepEqual(kinds('select replace(a, b, c) from t', 'mysql'), ['read']);
  assert.deepEqual(kinds("select '"), ['read'], 'chaîne non terminée : pas de plantage');
});

test('dangers : sans WHERE, DROP, TRUNCATE, ALTER DROP', () => {
  assert.equal(dangers('UPDATE t SET a = 1').length, 1);
  assert.equal(dangers('DELETE FROM t').length, 1);
  assert.equal(dangers('UPDATE t SET a = 1 WHERE id = 1').length, 0);
  assert.equal(dangers('DELETE FROM t USING u WHERE t.a = u.a').length, 0);
  assert.equal(dangers("UPDATE t SET a = 'where'").length, 1, 'WHERE dans une chaîne ne compte pas');
  assert.equal(dangers('UPDATE t SET a = 1 -- where\n').length, 1, 'WHERE en commentaire ne compte pas');
  assert.equal(dangers('DROP TABLE t').length, 1);
  assert.equal(dangers('TRUNCATE t').length, 1);
  assert.equal(dangers('ALTER TABLE t DROP COLUMN a').length, 1);
  assert.equal(dangers('ALTER TABLE t ADD COLUMN a int').length, 0);
  assert.equal(dangers('WITH x AS (SELECT 1) DELETE FROM t').length, 1);
  assert.equal(dangers('SELECT * FROM t').length, 0);
  assert.equal(dangers('SELECT 1; DELETE FROM t; DROP TABLE u').length, 2, 'une alerte par instruction');
  assert.equal(dangers('UPDATE `where` SET a = 1', 'mysql').length, 1, 'identifiant nommé where');
});

test('assessRun : lecture seule, confirmation, production', () => {
  let a = assessRun('SELECT 1', 'postgres', { ...opts, readOnly: true });
  assert.equal(a.blocked, undefined); assert.equal(a.confirm, undefined);
  a = assessRun('SELECT 1; DELETE FROM t WHERE a = 1', 'postgres', { ...opts, readOnly: true });
  assert.match(a.blocked, /lecture seule.*DELETE FROM t WHERE a = 1/);
  a = assessRun('SET autocommit = 1', 'mysql', { ...opts, readOnly: true });
  assert.ok(a.blocked);
  a = assessRun('SET search_path = x', 'postgres', { ...opts, readOnly: true });
  assert.equal(a.blocked, undefined);

  a = assessRun('DELETE FROM t', 'postgres', opts);
  assert.match(a.confirm.message, /destructrice/);
  assert.match(a.confirm.detail, /DELETE sans WHERE/);
  a = assessRun('DELETE FROM t', 'postgres', { ...opts, confirmDangerous: false });
  assert.equal(a.confirm, undefined);

  a = assessRun('UPDATE t SET a = 1 WHERE id = 3', 'postgres', { ...opts, production: true });
  assert.match(a.confirm.message, /PRODUCTION/);
  assert.match(a.confirm.detail, /UPDATE t SET a = 1 WHERE id = 3/);
  a = assessRun('SELECT 1', 'postgres', { ...opts, production: true });
  assert.equal(a.confirm, undefined, 'lecture : aucune confirmation en production');
  a = assessRun('UPDATE t SET a = 1 WHERE id = 3', 'postgres', { ...opts, production: true, confirmProduction: false });
  assert.equal(a.confirm, undefined);
  a = assessRun('DELETE FROM t', 'postgres', { ...opts, production: true });
  assert.match(a.confirm.detail, /DELETE sans WHERE/);
  assert.match(a.confirm.detail, /Connexion de production/);
  assert.equal(assessRun('', 'postgres', opts).statements.length, 0);
});

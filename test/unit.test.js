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
  assert.match(q.sql, /WHERE \("id"::text ILIKE \$1 ESCAPE '!' OR "nom"::text ILIKE \$1 ESCAPE '!'\) ORDER BY/);
  assert.ok(!q.sql.includes('"bin"'));
  assert.deepEqual(q.params, ['%a!%b%']);
});

test('filtre MySQL : un paramètre par colonne, colonnes binaires exclues', () => {
  const q = buildPageQuery({ ...base, dbType: 'mysql', columns: mysqlCols, filter: 'x' });
  assert.match(q.sql, /WHERE \(CAST\(`id` AS CHAR\) LIKE \? ESCAPE '!' OR CAST\(`nom` AS CHAR\) LIKE \? ESCAPE '!'\)/);
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

// ---------------------------------------------------------------- auto-complétion
const C = require('../.test-build/completion.js');
const { QueryHistory, MAX_HISTORY } = require('../.test-build/history.js');
const { SchemaCache } = require('../.test-build/schemaCache.js');

const view = (extra = {}) => {
  const data = {
    shop: {
      produits: [col('id', 'integer', { primaryKey: true }), col('nom'), col('prix', 'numeric')],
      commandes: [col('id', 'integer', { primaryKey: true }), col('produit_id', 'integer')],
    },
    autre: { logs: [col('msg')] },
  };
  return {
    dbType: 'postgres', containers: ['shop', 'autre'], defaultContainer: 'shop',
    tables: (c) => data[c] && Object.keys(data[c]).map((name) => ({ name, isView: name === 'logs' })),
    columns: (c, t) => data[c]?.[t],
    ...extra,
  };
};
const at = (sqlWithBar, dbType = 'postgres') => {
  const off = sqlWithBar.indexOf('|');
  const text = sqlWithBar.replace('|', '');
  const { statement, before } = C.currentStatement(text, off, dbType);
  const ctx = C.analyzeContext(before, dbType);
  return { ctx, refs: C.referencedTables(statement, dbType), statement };
};
const labels = (r) => r.map((x) => x.label);

test('tables citées : alias, AS, schéma, JOIN, liste à virgules, mots-clés non pris pour des alias', () => {
  const refs = (sql) => C.referencedTables(sql, 'postgres');
  assert.deepEqual(refs('SELECT * FROM produits p WHERE p.id = 1'), [{ table: 'produits', alias: 'p' }]);
  assert.deepEqual(refs('SELECT * FROM shop.produits AS p'), [{ container: 'shop', table: 'produits', alias: 'p' }]);
  assert.deepEqual(refs('SELECT * FROM produits WHERE id = 1'), [{ table: 'produits', alias: undefined }]);
  assert.deepEqual(refs('SELECT * FROM a x JOIN b y ON x.i = y.i LEFT JOIN c ON 1=1'),
    [{ table: 'a', alias: 'x' }, { table: 'b', alias: 'y' }, { table: 'c', alias: undefined }]);
  assert.deepEqual(refs('SELECT * FROM a x, b y, c ORDER BY 1').map((r) => `${r.table}:${r.alias}`), ['a:x', 'b:y', 'c:undefined']);
  assert.deepEqual(refs('UPDATE produits SET a = 1').map((r) => r.table), ['produits']);
  assert.deepEqual(refs("SELECT 'FROM fantome' FROM vraie").map((r) => r.table), ['vraie']);
});

test('contexte de saisie : qualificatifs, préfixe, clause ; rien dans les chaînes et commentaires', () => {
  let { ctx } = at('SELECT * FROM prod|');
  assert.deepEqual(ctx, { qualifiers: [], prefix: 'prod', clause: 'FROM' });
  ({ ctx } = at('SELECT p.| FROM produits p'));
  assert.deepEqual(ctx, { qualifiers: ['p'], prefix: '', clause: 'SELECT' });
  ({ ctx } = at('SELECT shop.produits.n| FROM produits'));
  assert.deepEqual(ctx.qualifiers, ['shop', 'produits']);
  assert.equal(ctx.prefix, 'n');
  ({ ctx } = at('SELECT * FROM produits WHERE |'));
  assert.equal(ctx.clause, 'WHERE');
  ({ ctx } = at('SELECT 1; SELECT * FROM |'));
  assert.equal(ctx.clause, 'FROM', 'seule l\'instruction courante compte');
  ({ ctx } = at('SELECT 1;\n|'));
  assert.deepEqual(ctx, { qualifiers: [], prefix: '', clause: '' });
  assert.equal(at("SELECT 'abc|'").ctx, undefined);
  assert.equal(at('SELECT 1 -- note |').ctx, undefined);
  assert.equal(at('SELECT /* x |').ctx, undefined);
  assert.equal(at('SELECT $$ x |').ctx, undefined);
});

test('propositions : tables après FROM, colonnes avec alias, schéma qualifié', () => {
  let { ctx, refs } = at('SELECT * FROM |');
  let items = C.complete(ctx, refs, view());
  assert.ok(labels(items).includes('produits') && labels(items).includes('commandes'));
  assert.ok(labels(items).includes('autre.logs'), 'hors schéma par défaut : qualifié');
  assert.ok(labels(items).includes('autre') && !labels(items).includes('SELECT'), 'pas de mots-clés après FROM');
  assert.equal(items.find((i) => i.label === 'autre.logs').kind, 'view');

  ({ ctx, refs } = at('SELECT p.| FROM produits p JOIN commandes c ON c.produit_id = p.id'));
  items = C.complete(ctx, refs, view());
  assert.deepEqual(labels(items), ['id', 'nom', 'prix'], 'colonnes de produits seulement');
  assert.match(items[0].detail, /p → produits · integer · clé primaire/);

  ({ ctx, refs } = at('SELECT c.| FROM produits p JOIN commandes c ON 1 = 1'));
  assert.deepEqual(labels(C.complete(ctx, refs, view())), ['id', 'produit_id']);

  ({ ctx, refs } = at('SELECT commandes.| FROM commandes'));
  assert.deepEqual(labels(C.complete(ctx, refs, view())), ['id', 'produit_id'], 'nom de table sans alias');

  ({ ctx, refs } = at('SELECT * FROM autre.|'));
  assert.deepEqual(labels(C.complete(ctx, refs, view())), ['logs']);

  ({ ctx, refs } = at('SELECT autre.logs.| FROM x'));
  assert.deepEqual(labels(C.complete(ctx, refs, view())), ['msg']);

  ({ ctx, refs } = at('SELECT | FROM produits p, commandes c'));
  items = C.complete(ctx, refs, view());
  assert.ok(['id', 'nom', 'produit_id'].every((l) => labels(items).includes(l)));
  assert.ok(labels(items).includes('SELECT') && labels(items).includes('COUNT(*)'));

  ({ ctx, refs } = at('SELECT * FROM produits WHERE |'));
  items = C.complete(ctx, refs, view());
  assert.ok(labels(items).includes('nom') && !labels(items).includes('commandes'), 'pas de tables dans WHERE');
});

test('propositions : quoting des noms atypiques, MySQL', () => {
  const v = view({
    dbType: 'postgres',
    tables: () => [{ name: 'Mixte Casse', isView: false }, { name: 'simple', isView: false }],
    columns: () => [col('Col A'), col('col_b')],
    containers: ['shop'],
  });
  let { ctx, refs } = at('SELECT * FROM |');
  const t = C.complete(ctx, refs, v);
  assert.equal(t.find((i) => i.label === 'Mixte Casse').insertText, '"Mixte Casse"');
  assert.equal(t.find((i) => i.label === 'simple').insertText, 'simple');
  ({ ctx, refs } = at('SELECT x.| FROM simple x'));
  const c = C.complete(ctx, refs, v);
  assert.deepEqual(c.map((i) => i.insertText), ['"Col A"', 'col_b']);

  const my = { ...v, dbType: 'mysql', containers: ['d1', 'd2'], defaultContainer: 'd1', tables: (c) => [{ name: 'T-1', isView: false }] };
  ({ ctx, refs } = at('SELECT * FROM |', 'mysql'));
  const mt = C.complete(ctx, refs, my);
  assert.equal(mt.find((i) => i.label === 'T-1').insertText, '`T-1`');
  assert.equal(mt.find((i) => i.label === 'd2.T-1').insertText, 'd2.`T-1`');
});

test('tablesNeeded : colonnes à charger avant de répondre', () => {
  let { ctx, refs } = at('SELECT p.| FROM produits p JOIN commandes c ON 1=1');
  assert.deepEqual(C.tablesNeeded(ctx, refs, view()), [{ container: 'shop', table: 'produits' }]);
  ({ ctx, refs } = at('SELECT | FROM produits p JOIN autre.logs ON 1=1'));
  assert.deepEqual(C.tablesNeeded(ctx, refs, view()),
    [{ container: 'shop', table: 'produits' }, { container: 'autre', table: 'logs' }]);
  ({ ctx, refs } = at('SELECT * FROM |'));
  assert.deepEqual(C.tablesNeeded(ctx, refs, view()), []);
  ({ ctx, refs } = at('SELECT | FROM inconnue'));
  assert.deepEqual(C.tablesNeeded(ctx, refs, view()), []);
});

test('historique : récent en premier, doublon remonté, borné, vide ignoré', async () => {
  const mem = {};
  const store = { get: (k, d) => mem[k] ?? d, update: async (k, v) => { mem[k] = v; } };
  let t = 1000;
  const h = new QueryHistory(store, () => ++t);
  await h.add({ sql: 'SELECT 1', connectionId: 'a', connectionName: 'A', ok: true });
  await h.add({ sql: '  ', connectionId: 'a', connectionName: 'A', ok: true });
  await h.add({ sql: 'SELECT 2', connectionId: 'a', connectionName: 'A', ok: false });
  await h.add({ sql: 'SELECT 1', connectionId: 'b', connectionName: 'B', ok: true });
  await h.add({ sql: ' SELECT 1 ', connectionId: 'a', connectionName: 'A', ok: true });
  assert.deepEqual(h.list().map((e) => `${e.connectionId}:${e.sql}`), ['a:SELECT 1', 'b:SELECT 1', 'a:SELECT 2']);
  assert.equal(h.list()[0].at, 1004, 'horodatage de la dernière exécution');
  for (let i = 0; i < MAX_HISTORY + 20; i++) {
    await h.add({ sql: 'SELECT ' + (100 + i), connectionId: 'a', connectionName: 'A', ok: true });
  }
  assert.equal(h.list().length, MAX_HISTORY);
  assert.equal(h.list()[0].sql, 'SELECT ' + (100 + MAX_HISTORY + 19));
  await h.clear();
  assert.deepEqual(h.list(), []);
});

test('cache du schéma : une seule lecture, rechargement après expiration ou invalidation', async () => {
  let calls = 0; let now = 0; let colCalls = 0;
  const driver = {
    listContainers: async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return ['s']; },
    listTables: async () => [{ name: 't', isView: false }],
    listColumns: async () => { colCalls++; return [col('a')]; },
  };
  const cache = new SchemaCache(async () => driver, () => now);
  const cfg = { id: 'c1', type: 'postgres' };
  await Promise.all([cache.load('c1'), cache.load('c1'), cache.load('c1')]);
  assert.equal(calls, 1, 'chargements simultanés regroupés');
  await cache.load('c1');
  assert.equal(calls, 1);
  assert.deepEqual(cache.view('c1', cfg).containers, ['s']);
  assert.equal(cache.view('c1', cfg).tables('s').length, 1);
  assert.equal(cache.view('c1', cfg).defaultContainer, 'public');
  assert.equal(cache.view('c1', cfg).columns('s', 't'), undefined);
  await cache.loadColumns('c1', 's', 't'); await cache.loadColumns('c1', 's', 't');
  assert.equal(colCalls, 1);
  assert.equal(cache.view('c1', cfg).columns('s', 't').length, 1);
  now = 6 * 60 * 1000;
  assert.deepEqual(cache.view('c1', cfg).containers, [], 'expiré');
  await cache.load('c1');
  assert.equal(calls, 2);
  cache.invalidate('c1');
  assert.deepEqual(cache.view('c1', cfg).containers, []);
  assert.equal(cache.view('c1', cfg).columns('s', 't'), undefined);
});

test('navigation : égalité exacte seule, puis combinée au filtre (numérotation des paramètres)', () => {
  const w = { column: 'id', value: '42' };
  let q = buildPageQuery({ ...base, dbType: 'postgres', columns: cols, where: w });
  assert.equal(q.sql, 'SELECT * FROM "shop"."t" WHERE "id" = $1 ORDER BY "id" LIMIT 101 OFFSET 0');
  assert.deepEqual(q.params, ['42']);
  q = buildPageQuery({ ...base, dbType: 'postgres', columns: cols, where: w, filter: 'x' });
  assert.match(q.sql, /WHERE "id" = \$1 AND \("id"::text ILIKE \$2 ESCAPE '!' OR "nom"::text ILIKE \$2 ESCAPE '!'\)/);
  assert.deepEqual(q.params, ['42', '%x%']);
  q = buildPageQuery({ ...base, dbType: 'mysql', columns: mysqlCols, where: w, filter: 'x' });
  assert.match(q.sql, /WHERE `id` = \? AND \(CAST\(`id` AS CHAR\) LIKE \? ESCAPE '!' OR CAST\(`nom` AS CHAR\) LIKE \? ESCAPE '!'\)/);
  assert.deepEqual(q.params, ['42', '%x%', '%x%']);
  const c = buildCountQuery({ ...base, dbType: 'postgres', columns: cols, where: w });
  assert.equal(c.sql, 'SELECT COUNT(*) FROM "shop"."t" WHERE "id" = $1');
  q = buildPageQuery({ ...base, dbType: 'postgres', columns: cols, where: { column: 'x"y', value: "1'; DROP" } });
  assert.ok(q.sql.includes('"x""y" = $1') && !q.sql.includes('DROP'));
});

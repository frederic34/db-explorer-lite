// Comparaison de schémas : normalisation, ordre de création, réécriture de la cible, SQLite.
const test = require('node:test');
const assert = require('node:assert/strict');
const { diffSchemas } = require('../.test-build/schemaDiff.js');

const col = (name, type, o = {}) => ({ name, type, nullable: true, primaryKey: false, default: null, ...o });
const tbl = (columns, o = {}) => ({ isView: false, columns, indexes: [], constraints: [], ddl: '', ...o });
const snap = (dbType, container, tables) => ({ dbType, container, tables: new Map(Object.entries(tables)) });

test('schémas équivalents : aucune différence malgré largeurs int, casse, ::cast, nextval d\'un autre schéma', () => {
  const mk = (schema) => snap('postgres', schema, {
    t: tbl([col('id', 'integer', { nullable: false, primaryKey: true, default: `nextval('${schema}.t_id_seq'::regclass)` }), col('nom', 'text', { default: "'x'::text" })],
      { constraints: [{ name: 't_pkey', kind: 'PRIMARY KEY', definition: '(id)' }], indexes: [{ name: 't_pkey', columns: ['id'], unique: true, primary: true }] }),
    u: tbl([col('t_id', 'integer')], { constraints: [{ name: 'u_fk', kind: 'FOREIGN KEY', definition: `(t_id) REFERENCES ${schema}.t(id)` }] }),
  });
  assert.deepEqual(diffSchemas(mk('a'), mk('b')).items, []);
  const my = (c, w) => snap('mysql', c, { t: tbl([col('id', `int(${w})`, { default: 'CURRENT_TIMESTAMP' }), col('d', 'datetime', { default: 'current_timestamp()' })]) });
  assert.deepEqual(diffSchemas(my('a', 11), my('b', 10)).items.filter((i) => i.name === 'id' && /type/.test(i.detail)), []);
});

test('création : parents avant enfants, références réécrites vers la cible, clés dans CREATE TABLE', () => {
  const a = snap('postgres', 'ref', {
    zz_enfant: tbl([col('id', 'integer', { nullable: false, primaryKey: true }), col('p', 'integer')], {
      constraints: [{ name: 'e_pk', kind: 'PRIMARY KEY', definition: '(id)' }, { name: 'e_fk', kind: 'FOREIGN KEY', definition: '(p) REFERENCES ref.aa_parent(id)' }],
      indexes: [{ name: 'e_pk', columns: ['id'], unique: true, primary: true }, { name: 'e_idx', columns: ['p'], unique: false, primary: false, method: 'btree' }, { name: 'e_gin', columns: ['p'], unique: false, primary: false, method: 'gin' }] }),
    aa_parent: tbl([col('id', 'integer', { nullable: false, primaryKey: true, default: "nextval('ref.aa_parent_id_seq'::regclass)" })], { constraints: [{ name: 'p_pk', kind: 'PRIMARY KEY', definition: '(id)' }] }),
  });
  const d = diffSchemas(a, snap('postgres', 'cible', {}));
  const s = d.script;
  assert.ok(s.indexOf('"cible"."aa_parent"') < s.indexOf('"cible"."zz_enfant"'), 'parent d\'abord');
  assert.match(s, /REFERENCES cible\.aa_parent\(id\)/);
  assert.match(s, /"id" serial/);
  assert.match(s, /CREATE INDEX "e_idx" ON "cible"\."zz_enfant" \("p"\);/);
  assert.match(s, /CREATE INDEX "e_gin" ON "cible"\."zz_enfant" USING gin \("p"\);/);
  assert.ok(!/nextval/.test(s));
});

test('MySQL : KEY dans CREATE TABLE, DROP FOREIGN KEY / INDEX en commentaire, MODIFY COLUMN', () => {
  const a = snap('mysql', 'a', { t: tbl([col('id', 'int', { nullable: false, primaryKey: true, extra: 'auto_increment' }), col('n', 'varchar(20)', { nullable: false, default: "'x'" })], {
    constraints: [{ name: 'PRIMARY', kind: 'PRIMARY KEY', definition: '(`id`)' }],
    indexes: [{ name: 'PRIMARY', columns: ['id'], unique: true, primary: true }, { name: 'k', columns: ['n'], unique: false, primary: false }] }) });
  const created = diffSchemas(a, snap('mysql', 'b', {})).script;
  assert.match(created, /`id` int NOT NULL AUTO_INCREMENT/);
  assert.match(created, /PRIMARY KEY \(`id`\)/);
  assert.match(created, /KEY `k` \(`n`\)/);
  const b = snap('mysql', 'b', { t: tbl([col('id', 'int', { nullable: false, primaryKey: true, extra: 'auto_increment' }), col('n', 'varchar(10)', { default: null }), col('old', 'int')], {
    constraints: [{ name: 'PRIMARY', kind: 'PRIMARY KEY', definition: '(`id`)' }, { name: 'fk_old', kind: 'FOREIGN KEY', definition: '(`old`) REFERENCES `b`.`x` (`id`)' }],
    indexes: [{ name: 'PRIMARY', columns: ['id'], unique: true, primary: true }, { name: 'old_idx', columns: ['old'], unique: false, primary: false }] }) });
  const s = diffSchemas(a, b).script;
  assert.match(s, /^ALTER TABLE `b`\.`t` MODIFY COLUMN `n` varchar\(20\) NOT NULL DEFAULT 'x';$/m);
  assert.match(s, /^-- ALTER TABLE `b`\.`t` DROP FOREIGN KEY `fk_old`;$/m);
  assert.match(s, /^-- DROP INDEX `old_idx` ON `b`\.`t`;$/m);
  assert.match(s, /^-- ALTER TABLE `b`\.`t` DROP COLUMN `old`;$/m);
  assert.match(s, /^CREATE INDEX `k` ON `b`\.`t` \(`n`\);$/m);
});

test('SQLite : ajout de colonne exécutable, modification signalée en commentaire', () => {
  const a = snap('sqlite', 'main', { t: tbl([col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('nom', 'TEXT', { nullable: false }), col('age', 'INTEGER')]) });
  const b = snap('sqlite', 'main', { t: tbl([col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('nom', 'TEXT')]) });
  const d = diffSchemas(a, b);
  assert.match(d.script, /^ALTER TABLE "t" ADD COLUMN "age" INTEGER;$/m);
  assert.match(d.script, /^-- SQLite ne sait pas modifier la colonne « nom »/m);
  assert.deepEqual(d.items.map((i) => [i.name, i.change]), [['nom', 'changed'], ['age', 'missing']]);
});

test('vues : absentes, différentes ou de nature différente → commentaires seulement', () => {
  const v = (ddl) => tbl([], { isView: true, ddl });
  const a = snap('postgres', 'a', { v1: v('CREATE VIEW a.v1 AS SELECT 1;'), v2: v('CREATE VIEW a.v2 AS SELECT 1;'), t: tbl([col('x', 'int')]) });
  const b = snap('postgres', 'b', { v2: v('CREATE VIEW b.v2 AS SELECT 2;'), t: v('x') });
  const d = diffSchemas(a, b);
  assert.deepEqual(d.items.map((i) => `${i.name}:${i.change}`).sort(), ['t:changed', 'v1:missing', 'v2:changed']);
  assert.ok(d.script.split('\n').every((l) => l === '' || l.startsWith('--')), 'aucune instruction exécutable');
});

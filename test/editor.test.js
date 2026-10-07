// Instruction sous le curseur et EXPLAIN (parties pures ; les plans réels sont vérifiés sur PG / MariaDB / SQLite).
const test = require('node:test');
const assert = require('node:assert/strict');
const { statementAt } = require('../.test-build/statementAt.js');
const { explainSql, isExplain, planToResult } = require('../.test-build/explain.js');
const { analyze } = require('../.test-build/sqlGuard.js');

const SCRIPT = "SELECT 1;\n\nSELECT ';' AS x, 'a'\n  FROM t;\nUPDATE t SET a = 1;";
const at = (needle, shift = 0, db = 'postgres') => statementAt(SCRIPT, SCRIPT.indexOf(needle) + shift, db)?.sql;

test('instruction sous le curseur : début, milieu, juste après le « ; », lignes vides, fin', () => {
  assert.equal(at('SELECT 1'), 'SELECT 1');
  assert.equal(at('SELECT 1', 8), 'SELECT 1', 'sur le point-virgule');
  assert.equal(at('SELECT 1', 9), 'SELECT 1', 'juste après le point-virgule');
  assert.equal(at('SELECT 1', 10), "SELECT ';' AS x, 'a'\n  FROM t", 'ligne vide : instruction suivante');
  assert.equal(at("';'", 1), "SELECT ';' AS x, 'a'\n  FROM t", 'point-virgule dans une chaîne');
  assert.equal(at('FROM t'), "SELECT ';' AS x, 'a'\n  FROM t");
  assert.equal(at('UPDATE', 3), 'UPDATE t SET a = 1');
  assert.equal(statementAt(SCRIPT + '\n\n', SCRIPT.length + 2, 'postgres').sql, 'UPDATE t SET a = 1', 'après la dernière');
  assert.equal(statementAt('  \n ', 1, 'mysql'), undefined);
  assert.equal(statementAt('', 0, 'mysql'), undefined);
});

test('statementAt : chaîne entre dollars PostgreSQL et commentaires', () => {
  const sql = "DO $$ BEGIN PERFORM 1; END $$;\n-- c ; d\nSELECT 2;";
  assert.match(statementAt(sql, 10, 'postgres').sql, /^DO \$\$/);
  assert.equal(statementAt(sql, sql.indexOf('SELECT'), 'postgres').sql.endsWith('SELECT 2'), true);
});

test('explainSql par SGBD ; isExplain', () => {
  assert.equal(explainSql('postgres', 'SELECT 1;', false).primary, 'EXPLAIN (FORMAT JSON) SELECT 1');
  assert.equal(explainSql('postgres', 'SELECT 1 ;\n', true).primary, 'EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) SELECT 1');
  assert.deepEqual(explainSql('mysql', 'SELECT 1', true), { primary: 'EXPLAIN ANALYZE SELECT 1', fallback: 'ANALYZE SELECT 1' });
  assert.equal(explainSql('mysql', 'SELECT 1', false).primary, 'EXPLAIN SELECT 1');
  assert.equal(explainSql('sqlite', 'SELECT 1', false).primary, 'EXPLAIN QUERY PLAN SELECT 1');
  assert.ok(isExplain('explain select 1') && isExplain('-- x\nEXPLAIN ANALYZE select 1') && isExplain('ANALYZE TABLE t'));
  assert.ok(!isExplain('SELECT 1') && !isExplain('SELECT explain FROM t'));
});

test('garde-fous : EXPLAIN ANALYZE d\'une écriture est une écriture, EXPLAIN simple et SELECT non', () => {
  const kind = (s) => analyze(s, 'postgres')[0].kind;
  assert.equal(kind('EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) DELETE FROM t'), 'write');
  assert.equal(kind('EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) SELECT 1'), 'read');
  assert.equal(kind('EXPLAIN (FORMAT JSON) DELETE FROM t'), 'read');
});

test('planToResult : arbre PostgreSQL, SQLite, texte MySQL', () => {
  const plan = [{ Plan: { 'Node Type': 'Hash Join', 'Join Type': 'Inner', 'Startup Cost': 1, 'Total Cost': 5.5, 'Plan Rows': 10, 'Actual Total Time': 0.3, 'Actual Rows': 8, 'Actual Loops': 1, 'Hash Cond': '(a.id = b.id)',
    Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'a', 'Startup Cost': 0, 'Total Cost': 2, 'Plan Rows': 10, Filter: '(x > 1)', 'Rows Removed by Filter': 4, 'Actual Total Time': 0.1, 'Actual Rows': 6, 'Actual Loops': 1 },
      { 'Node Type': 'Index Scan', 'Relation Name': 'b', 'Index Name': 'b_pkey', 'Startup Cost': 0, 'Total Cost': 1, 'Plan Rows': 1 }] }, 'Planning Time': 0.2, 'Execution Time': 0.5 }];
  const raw = { columns: ['QUERY PLAN'], rows: [[JSON.stringify(plan)]], rowCount: 1, truncated: false, durationMs: 3 };
  const r = planToResult('postgres', raw, true);
  assert.deepEqual(r.columns, ['Étape', 'Coût estimé', 'Lignes est.', 'Temps (ms/boucle)', 'Lignes réelles', 'Boucles', 'Détail']);
  assert.equal(r.rows[0][0], 'Hash Join');
  assert.equal(r.rows[1][0], '└ Seq Scan sur a');
  assert.match(r.rows[1][6], /parcours séquentiel/);
  assert.equal(r.rows[2][0], '└ Index Scan sur b (b_pkey)');
  assert.deepEqual(r.rows.slice(-2).map((x) => [x[0], x[3]]), [['Planification (ms)', '0.2'], ['Exécution (ms)', '0.5']]);
  const noA = planToResult('postgres', raw, false);
  assert.deepEqual(noA.columns, ['Étape', 'Coût estimé', 'Lignes est.', 'Détail']);
  assert.equal(planToResult('postgres', { ...raw, rows: [['pas du json']] }, false).rows[0][0], 'pas du json', 'repli sur le brut');

  const lite = planToResult('sqlite', { columns: ['id', 'parent', 'notused', 'detail'], rows: [['2', '0', '0', 'SCAN a'], ['5', '2', '0', 'SEARCH b USING INTEGER PRIMARY KEY (rowid=?)']], rowCount: 2, truncated: false, durationMs: 1 }, false);
  assert.deepEqual(lite.columns, ['Étape', 'Remarque']);
  assert.equal(lite.rows[0][1], '⚠ parcours complet de la table');
  assert.ok(lite.rows[1][0].startsWith(' ') || lite.rows[1][0].startsWith('└'));
  assert.equal(lite.rows[1][1], '');

  const my = planToResult('mysql', { columns: ['EXPLAIN'], rows: [['-> Filter: (x > 1)  (cost=1)\n    -> Table scan on t\n']], rowCount: 1, truncated: false, durationMs: 1 }, true);
  assert.equal(my.rows.length, 2);
  assert.ok(my.rows[1][0].startsWith('    ->'));
  const tab = { columns: ['id', 'type'], rows: [['1', 'ALL']], rowCount: 1, truncated: false, durationMs: 1 };
  assert.equal(planToResult('mysql', tab, false), tab, 'tableau MySQL classique inchangé');
});

test('editorKind : JSON, date, heure, datetime ; fuseaux horaires et autres types en texte libre', () => {
  const { editorKind } = require('../.test-build/editing.js');
  const k = (db, t) => editorKind(db, t);
  assert.equal(k('postgres', 'jsonb'), 'json');
  assert.equal(k('mysql', 'json'), 'json');
  assert.equal(k('sqlite', 'JSON'), '');
  assert.equal(k('postgres', 'date'), 'date');
  assert.equal(k('mysql', 'datetime(6)'), 'datetime');
  assert.equal(k('mysql', 'timestamp'), 'datetime');
  assert.equal(k('postgres', 'timestamp(3) without time zone'), 'datetime');
  assert.equal(k('postgres', 'timestamp with time zone'), '');
  assert.equal(k('postgres', 'timestamptz'), '');
  assert.equal(k('postgres', 'time without time zone'), 'time');
  assert.equal(k('postgres', 'time with time zone'), '');
  assert.equal(k('mysql', 'time(3)'), 'time');
  assert.equal(k('postgres', 'text'), '');
  assert.equal(k('mysql', 'varchar(20)'), '');
});

test('parseSimpleSelect : SELECT * d\'une seule table seulement', () => {
  const { parseSimpleSelect: p } = require('../.test-build/simpleSelect.js');
  assert.deepEqual(p('SELECT * FROM clients', 'postgres'), { table: 'clients' });
  assert.deepEqual(p('select * from public.clients c where c.id > 3 order by id limit 10;', 'postgres'), { container: 'public', table: 'clients' });
  assert.deepEqual(p('SELECT * FROM "Mon Schéma"."T ""x"""', 'postgres'), { container: 'Mon Schéma', table: 'T "x"' });
  assert.deepEqual(p('SELECT * FROM `db`.`t` WHERE a = \'JOIN\'', 'mysql'), { container: 'db', table: 't' });
  assert.deepEqual(p('SELECT *\nFROM t\nLIMIT 5 OFFSET 2', 'sqlite'), { table: 't' });
  assert.deepEqual(p('SELECT * FROM t AS x WHERE x.a IN (SELECT a FROM u)', 'postgres'), { table: 't' });
  for (const bad of [
    'SELECT id FROM t', 'SELECT t.* FROM t', 'SELECT * FROM a JOIN b ON a.id = b.id', 'SELECT * FROM a, b',
    'SELECT * FROM a UNION SELECT * FROM b', 'SELECT DISTINCT * FROM t', 'SELECT * FROM t GROUP BY a',
    'SELECT * FROM (SELECT 1) s', 'WITH x AS (SELECT 1) SELECT * FROM x', 'SELECT * FROM t; SELECT * FROM u',
    'SELECT * INTO copie FROM t', 'DELETE FROM t', 'SELECT * FROM t HAVING a > 1', 'SELECT * FROM t WINDOW w AS ()',
  ]) {
    assert.equal(p(bad, 'postgres'), undefined, bad);
  }
});

test('formats de copie : TSV (guillemets, NULL vide) et Markdown (| échappé, retours ligne, NULL)', async () => {
  const { formatRows } = require('../.test-build/exporter.js');
  const cols = [{ name: 'a' }, { name: 'b|c' }];
  const rows = [['x\ty', null], ['ligne1\nligne2', 'p|q'], ['dit "oui"', '\\']];
  const tsv = (await formatRows({ format: 'tsv', columns: cols }, rows)).text;
  assert.equal(tsv, 'a\tb|c\n"x\ty"\t\n"ligne1\nligne2"\tp|q\n"dit ""oui"""\t\\\n');
  const md = (await formatRows({ format: 'md', columns: cols }, rows)).text;
  assert.equal(md, '| a | b\\|c |\n| --- | --- |\n| x\ty | NULL |\n| ligne1<br>ligne2 | p\\|q |\n| dit "oui" | \\\\ |\n');
});

test('cellView : image reconnue aux octets, taille binaire, URL, valeur longue, hexa, requête de lecture', () => {
  const cv = require('../.test-build/cellView.js');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  assert.deepEqual(cv.sniffImage(png), { mime: 'image/png', label: 'PNG' });
  assert.equal(cv.sniffImage(Buffer.from('ffd8ffe000104a46', 'hex')).label, 'JPEG');
  assert.equal(cv.sniffImage(Buffer.from('GIF89a......', 'latin1')).label, 'GIF');
  assert.equal(cv.sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])).label, 'WebP');
  assert.equal(cv.sniffImage(Buffer.from('<svg onload=alert(1)>')), undefined, 'SVG jamais affiché comme image');
  assert.equal(cv.sniffImage(Buffer.from('MZ\x90\x00')), undefined);
  assert.equal(cv.binarySize('<binaire 4096 octets>'), 4096);
  assert.equal(cv.binarySize('0x0102ff'), 3);
  assert.equal(cv.binarySize('0x123'), undefined);
  assert.equal(cv.binarySize('texte'), undefined);
  assert.equal(cv.httpUrl('https://exemple.fr/a?b=1#c'), 'https://exemple.fr/a?b=1#c');
  for (const bad of ['javascript:alert(1)', 'ftp://x', 'http://', 'http://a b', 'vu sur https://x.fr', 'file:///etc/passwd', 'https://x.fr/' + 'a'.repeat(2000), null]) {
    assert.equal(cv.httpUrl(bad), undefined, String(bad).slice(0, 30));
  }
  assert.deepEqual(cv.prettyValue('{"a":[1,2]}'), { text: '{\n  "a": [\n    1,\n    2\n  ]\n}\n', language: 'json' });
  assert.equal(cv.prettyValue('{pas json').language, 'plaintext');
  assert.equal(cv.prettyValue('<a>x</a>').language, 'xml');
  const d = cv.hexDump(Buffer.from('ABCDEFGHIJKLMNOPQR'));
  assert.match(d, /^00000000  41 42 43 44 45 46 47 48 49 4a 4b 4c 4d 4e 4f 50  ABCDEFGHIJKLMNOP\n00000010  51 52 /);
  assert.equal(cv.hexSelect('postgres', 's', 't', 'img', ['id', 'v']), `SELECT encode("img", 'hex') FROM "s"."t" WHERE "id" = $1 AND "v" = $2`);
  assert.equal(cv.hexSelect('mysql', 'd', 't', 'img', ['id']), 'SELECT HEX(`img`) FROM `d`.`t` WHERE `id` = ?');
  assert.equal(cv.hexSelect('sqlite', 'main', 't', 'img', ['id']), 'SELECT HEX("img") FROM "t" WHERE "id" = ?');
});

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

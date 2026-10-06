// Fonctions de la 0.6 sur une vraie base : structure (DDL rejoué), jeux de résultats multiples, exports.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createDriver } = require('../.test-build/drivers.js');
const { ResultsPanel } = require('../.test-build/panel.js');
const { formatRows, streamTable } = require('../.test-build/exporter.js');
const { buildPageQuery, buildCountQuery, parseFilter, keysetColumns } = require('../.test-build/browse.js');
const { explainSql, planToResult } = require('../.test-build/explain.js');
const { buildEdges, layoutEr, toMermaid } = require('../.test-build/erLayout.js');

const KIND = process.argv[2];
const { PG, MY } = require('./config');
const { seed } = require('./seed');
const CFG = (KIND === 'pg' ? PG : MY).cfg;
const PW = (KIND === 'pg' ? PG : MY).password;
const q = (n) => (KIND === 'pg' ? `"${n}"` : `\`${n}\``);
const T = (s, n) => `${q(s)}.${q(n)}`;

let passed = 0;
const ok = (label, extra = '') => { passed++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`); };
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
async function until(cond, label, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (cond()) return; await tick(); }
  throw new Error('délai dépassé : ' + label);
}
const driver = createDriver(CFG, PW, { maxRows: () => 5000, showSystem: () => false });
const db = (sql, params) => driver.query(sql, params);
const run = (statements) => (KIND === 'pg' ? driver.query(statements.join(';\n')) : driver.script(statements));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-feat-'));

(async () => {
  await seed(KIND, driver);
  if (KIND === 'pg') { await db('DROP SCHEMA IF EXISTS shop2 CASCADE'); await db('CREATE SCHEMA shop2'); }
  else { await db('DROP DATABASE IF EXISTS shop2'); await db('CREATE DATABASE shop2 CHARACTER SET utf8mb4'); }

  // ------------------------------------------------------------ structure
  console.log('Structure des tables');
  const s = await driver.describeTable('shop', 'produits');
  assert.deepEqual(s.columns.map((c) => c.name), KIND === 'pg'
    ? ['id', 'nom', 'prix', 'cree_le', 'meta', 'actif', 'note', 'tags', 'bin'] : ['id', 'nom', 'prix', 'cree_le', 'meta', 'actif', 'note', 'bin']);
  const id = s.columns[0], nom = s.columns[1];
  assert.equal(id.primaryKey, true);
  assert.equal(nom.nullable, false);
  assert.equal(s.columns.find((c) => c.name === 'actif').default !== null, true);
  assert.ok(s.indexes.some((i) => i.primary && i.columns.join() === 'id'));
  assert.ok(s.constraints.some((k) => k.kind === 'PRIMARY KEY'));
  assert.ok(/CREATE TABLE/i.test(s.ddl) && s.ddl.includes('produits') && s.isView === false);
  ok('colonnes, clé primaire, défauts, index et contrainte PRIMARY KEY');

  const e = await driver.describeTable('shop', 'enfants');
  const fk = e.constraints.find((k) => k.kind === 'FOREIGN KEY');
  assert.ok(fk && /produits/.test(fk.definition) && /produit_id/.test(fk.definition), fk && fk.definition);
  const l = await driver.describeTable('shop', 'lignes');
  assert.ok(l.constraints.some((k) => k.kind === 'PRIMARY KEY' && /cmd/.test(k.definition) && /ligne/.test(k.definition)));
  assert.equal(l.indexes.find((i) => i.primary).columns.length, 2);
  ok('clé étrangère (table et colonnes) et clé primaire composite', fk.definition);

  if (KIND === 'pg') {
    const g = await driver.describeTable('shop', 'gen');
    assert.ok(/GENERATED ALWAYS AS \(.*\) STORED/.test(g.ddl), g.ddl);
    const i = await driver.describeTable('shop', 'ident');
    assert.ok(/GENERATED ALWAYS AS IDENTITY/.test(i.ddl));
  }
  await db(`CREATE VIEW ${T('shop', 'v_chers')} AS SELECT id, nom FROM ${T('shop', 'produits')} WHERE prix > 25`);
  const v = await driver.describeTable('shop', 'v_chers');
  assert.equal(v.isView, true);
  assert.ok(/VIEW/i.test(v.ddl) && /prix/.test(v.ddl));
  assert.deepEqual(v.columns.map((c) => c.name), ['id', 'nom']);
  await assert.rejects(driver.describeTable('shop', 'nexiste_pas'), /ntrouvable|doesn't exist|exist/);
  ok('colonnes générées / identité (PG), vue : DDL de la vue, table inconnue : erreur claire');

  // DDL rejoué dans un autre schéma : la structure doit être identique
  const norm = (x) => JSON.stringify(x).replace(/shop2/g, 'shop');
  const strip = (st) => ({
    columns: st.columns.map((c) => [c.name, c.type, c.nullable, c.primaryKey, c.default, c.extra]),
    indexes: st.indexes.map((i) => [i.name, i.columns, i.unique, i.primary]),
    constraints: st.constraints.map((k) => [k.name, k.kind, k.definition]),
  });
  for (const t of ['produits', 'enfants', 'lignes', 'tout_defaut', 'gen', 'uuids'].concat(KIND === 'pg' ? ['ident'] : [])) {
    const orig = await driver.describeTable('shop', t);
    let ddl = orig.ddl;
    if (KIND === 'pg') {
      await run([ddl.replace(/"shop"\./g, '"shop2".')]);
    } else {
      await driver.script(['USE shop2', ddl]);
    }
    const copy = await driver.describeTable('shop2', t);
    assert.equal(norm(strip(copy)), norm(strip(orig)), `structure rejouée de ${t}`);
  }
  ok('DDL rejoué dans un autre schéma : colonnes, index et contraintes identiques', '6 tables');

  // ------------------------------------------------------------ plusieurs jeux de résultats
  console.log('Jeux de résultats multiples');
  const r = await run(KIND === 'pg'
    ? ['SELECT 1 AS a', 'SELECT 2 AS b, 3 AS c', `UPDATE ${T('shop', 'sanspk')} SET b = b`]
    : ['SELECT 1 AS a', 'SELECT 2 AS b, 3 AS c', `UPDATE ${T('shop', 'sanspk')} SET b = b`]);
  assert.equal(r.sets.length, 3);
  assert.deepEqual(r.sets[0].columns, ['a']);
  assert.deepEqual(r.sets[1].rows, [['2', '3']]);
  assert.equal(r.sets[2].affectedRows, 2);
  assert.deepEqual(r.columns, [], 'résultat principal = dernier');
  assert.equal(r.affectedRows, 2);
  const single = await driver.query('SELECT 1');
  assert.equal(single.sets, undefined);
  ok('trois instructions : trois résultats, le principal est le dernier', `${r.sets.map((x) => x.columns.length ? x.rowCount + ' l.' : (x.command || 'ok')).join(' | ')}`);

  const panel = new ResultsPanel();
  const mount = () => {
    const p = global.__vsPanels[0];
    const sent = [];
    const dom = new JSDOM(p.html, { runScripts: 'dangerously', beforeParse(w) {
      global.__vsWin = w;
      w.acquireVsCodeApi = () => ({ postMessage: (m) => { sent.push(m); p.handlers.forEach((h) => h(m)); } });
    } });
    global.__vsWin = dom.window;
    return { d: dom.window.document, w: dom.window, sent };
  };
  panel.showResult('test', 'multi', r, [], CFG.type);
  let pg = mount();
  const tabs = () => [...pg.d.querySelectorAll('.tabs .tab')];
  assert.equal(tabs().length, 3);
  assert.ok(/Résultat 3\/3/.test(pg.d.querySelector('.top').textContent));
  assert.equal(tabs()[2].classList.contains('active'), true);
  tabs()[1].click();
  await tick(30);
  pg = mount();
  assert.ok(/Résultat 2\/3/.test(pg.d.querySelector('.top').textContent));
  assert.deepEqual([...pg.d.querySelectorAll('thead th')].map((t) => t.textContent).filter(Boolean).slice(-2), ['b', 'c']);
  assert.equal(pg.d.querySelectorAll('tbody tr').length, 1);
  tabs()[0].click();
  await tick(30);
  pg = mount();
  assert.equal(pg.d.querySelector('tbody td:last-child').textContent, '1');
  panel.showResult('test', 'x', await driver.query('SELECT 1'), [], CFG.type);
  assert.equal(mount().d.querySelectorAll('.tabs .tab').length, 0, 'plus d\'onglets pour un résultat simple');
  ok('onglets : bascule entre les résultats, résumé « Résultat k/N », disparition pour un résultat simple');

  // ------------------------------------------------------------ diagramme ER sur le vrai schéma
  console.log('Diagramme des relations');
  const erTables = [];
  for (const t of (await driver.listTables('shop')).filter((x) => !x.isView)) {
    const cs = await driver.listColumns('shop', t.name);
    erTables.push({ name: t.name, columns: cs.map((c) => ({ name: c.name, type: c.type, pk: c.primaryKey,
      fk: c.references && c.references.container === 'shop' ? { table: c.references.table, column: c.references.column } : undefined })) });
  }
  const erEdges = buildEdges(erTables);
  assert.ok(erEdges.some((e) => e.from === 'enfants' && e.to === 'produits' && e.fromCol === 'produit_id' && e.toCol === 'id'));
  const lay = layoutEr(erTables, erEdges, { keysOnly: false });
  const at = Object.fromEntries(lay.nodes.map((n) => [n.name, n]));
  assert.ok(at.enfants.x > at.produits.x, 'enfants à droite de produits');
  assert.equal(lay.nodes.length, erTables.length);
  assert.ok(toMermaid(erTables, erEdges).includes('produits ||--o{ enfants : "produit_id"'));
  ok('liens lus dans le schéma réel, disposition cohérente, Mermaid', `${erTables.length} tables, ${erEdges.length} relation(s)`);

  // ------------------------------------------------------------ export : formats rejoués
  console.log('Export');
  const cols = await driver.listColumns('shop', 'produits');
  const data = (await db(`SELECT * FROM ${T('shop', 'produits')} ORDER BY id`)).rows;
  const ecols = cols.map((c) => ({ name: c.name, type: c.type }));

  const sqlOut = await formatRows({ format: 'sql', columns: ecols, dbType: CFG.type, table: T('shop', 'produits_copie') }, data);
  assert.equal(sqlOut.lost, 0);
  await db(KIND === 'pg' ? `CREATE TABLE ${T('shop', 'produits_copie')} (LIKE ${T('shop', 'produits')} INCLUDING ALL)` : `CREATE TABLE ${T('shop', 'produits_copie')} LIKE ${T('shop', 'produits')}`);
  await run(sqlOut.text.split(/;\n/).map((x) => x.trim()).filter(Boolean));
  const back = (await db(`SELECT * FROM ${T('shop', 'produits_copie')} ORDER BY id`)).rows;
  assert.deepEqual(back, data);
  ok('INSERT SQL rejoué : la copie est identique à l\'original (JSON, binaire, NULL, accents, tableaux)', `${data.length} lignes`);

  // valeurs piégeuses : apostrophes, antislashs, retours à la ligne
  await db(`CREATE TABLE ${T('shop', 'piege')} (id int PRIMARY KEY, t ${KIND === 'pg' ? 'text' : 'TEXT'})`);
  const tricky = ["l'apostrophe", 'back\\slash \\n', 'ligne1\nligne2', "fin\\'", '%_!', '"guillemets"', ''];
  const inserts = tricky.map((t, i) => `(${i + 1}, ${KIND === 'pg' ? "'" + t.replace(/'/g, "''") + "'" : "'" + t.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"})`);
  await db(`INSERT INTO ${T('shop', 'piege')} VALUES ${inserts.join(',')}`);
  const pcols = [{ name: 'id', type: 'int' }, { name: 't', type: 'text' }];
  const prow = (await db(`SELECT * FROM ${T('shop', 'piege')} ORDER BY id`)).rows;
  const sqlP = await formatRows({ format: 'sql', columns: pcols, dbType: CFG.type, table: T('shop', 'piege2') }, prow);
  await db(`CREATE TABLE ${T('shop', 'piege2')} (id int PRIMARY KEY, t ${KIND === 'pg' ? 'text' : 'TEXT'})`);
  await run(sqlP.text.split(/;\n/).map((x) => x.trim()).filter(Boolean));
  assert.deepEqual((await db(`SELECT * FROM ${T('shop', 'piege2')} ORDER BY id`)).rows.map((x) => x[1]), tricky);
  ok('INSERT SQL : apostrophes, antislashs, retours à la ligne et chaînes vides restitués à l\'identique');

  const js = await formatRows({ format: 'json', columns: ecols }, data);
  const parsed = JSON.parse(js.text);
  assert.equal(parsed.length, 5);
  assert.strictEqual(parsed[0].id, 1);
  assert.strictEqual(parsed[0].prix, 10.5);
  assert.strictEqual(parsed[0].nom, 'Alpha');
  // MariaDB déclare JSON comme un alias de LONGTEXT : la colonne reste une chaîne
  if (KIND === 'pg') { assert.deepEqual(parsed[0].meta, { a: 1 }); } else { assert.strictEqual(parsed[0].meta, '{"a":1}'); }
  assert.strictEqual(parsed[1].note, null);
  assert.strictEqual(parsed[4].nom, 'Écho');
  ok('JSON : nombres, objets JSON et NULL typés, accents conservés');

  const csv = await formatRows({ format: 'csv', columns: ecols, csvSeparator: ';' }, data);
  assert.ok(csv.text.startsWith('﻿id;nom;prix'));
  assert.equal(csv.text.trim().split('\r\n').length, 6);
  ok('CSV : BOM, séparateur choisi, en-têtes');

  // ------------------------------------------------------------ export de la table entière
  const N = 5300;
  await db(`CREATE TABLE ${T('shop', 'gros')} (id int PRIMARY KEY, v ${KIND === 'pg' ? 'text' : 'VARCHAR(20)'})`);
  if (KIND === 'pg') { await db(`INSERT INTO ${T('shop', 'gros')} SELECT g, 'v' || g FROM generate_series(1, ${N}) g`); }
  else { await db(`INSERT INTO ${T('shop', 'gros')} SELECT seq, CONCAT('v', seq) FROM (SELECT @r3 := @r3 + 1 AS seq FROM information_schema.columns a, information_schema.columns b, (SELECT @r3 := 0) v LIMIT ${N}) t`); }
  const gcols = await driver.listColumns('shop', 'gros');
  const base = { dbType: CFG.type, container: 'shop', table: 'gros', columns: gcols };

  const seen = []; let batches = 0; const prog = [];
  const n = await streamTable({ driver, query: base, batch: 2000, isCancelled: () => false,
    onBatch: async (rows) => { batches++; seen.push(...rows.map((x) => Number(x[0]))); },
    onProgress: (d, t) => prog.push([d, t]) });
  assert.equal(n, N); assert.equal(batches, 3);
  assert.deepEqual(seen, Array.from({ length: N }, (_, i) => i + 1), 'ordre de la clé primaire, sans doublon ni trou');
  assert.deepEqual(prog[prog.length - 1], [N, N]);
  ok('lecture par lots de 2000 : 5300 lignes, 3 lots, ni doublon ni trou, progression avec total');

  const filt = [];
  await streamTable({ driver, query: { ...base, filter: 'v12', sort: { column: 'id', dir: 'desc' } }, batch: 100, isCancelled: () => false, onBatch: async (r) => filt.push(...r.map((x) => Number(x[0]))) });
  const expected = Array.from({ length: N }, (_, i) => i + 1).filter((i) => ('v' + i).includes('v12')).reverse();
  assert.deepEqual(filt, expected);
  let calls = 0;
  const cut = await streamTable({ driver, query: base, batch: 1000, isCancelled: () => calls >= 2, onBatch: async () => { calls++; } });
  assert.equal(cut, 2000);
  ok('filtre et tri de l\'aperçu appliqués à tout l\'export ; annulation entre deux lots', `${expected.length} lignes filtrées`);

  // via le panneau : JSON de la table entière, fichier réel
  const preview = async (table, setup = {}) => {
    const tableColumns = await driver.listColumns('shop', table);
    await panel.openTable({ dbType: CFG.type, container: 'shop', table, tableColumns, getDriver: async () => driver, connectionName: 'test', isView: false, pageSize: 200, ...setup });
    return mount();
  };
  const exportBtn = (p) => [...p.d.querySelectorAll('.bar button')].find((b) => /Exporter/.test(b.textContent));
  let page = await preview('gros');
  const file = path.join(tmp, 'gros.json');
  global.__picks = ['JSON', 'Toute la table']; global.__saveUri = { fsPath: file, scheme: 'file' }; global.__infos = [];
  exportBtn(page).click();
  await until(() => (global.__infos || []).some((m) => /Export enregistré/.test(m)), 'export json');
  const out = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(out.length, N);
  assert.strictEqual(out[N - 1].id, N);
  assert.strictEqual(out[0].v, 'v1');
  ok('panneau : export JSON de la table entière dans un vrai fichier', `${out.length} lignes, ${Math.round(fs.statSync(file).size / 1024)} Ko`);

  // INSERT SQL de la table entière avec un filtre actif
  page = await preview('gros');
  const filterInput = page.d.querySelector('.bar input[type=search]');
  filterInput.value = 'v99'; filterInput.dispatchEvent(new page.w.Event('input', { bubbles: true }));
  await until(() => page.d.querySelector('.pager .pos') && /sur 1\d\b/.test(page.d.querySelector('.pager .pos').textContent), 'filtre appliqué');
  const f2 = path.join(tmp, 'gros.sql');
  global.__picks = ['INSERT SQL', 'Toute la table']; global.__saveUri = { fsPath: f2, scheme: 'file' }; global.__infos = [];
  exportBtn(page).click();
  await until(() => (global.__infos || []).some((m) => /Export enregistré/.test(m)), 'export sql');
  const sqlTxt = fs.readFileSync(f2, 'utf8');
  assert.ok(sqlTxt.startsWith(`INSERT INTO ${T('shop', 'gros')} (${q('id')}, ${q('v')}) VALUES`));
  assert.ok(!sqlTxt.includes("'v1')"), 'les lignes hors filtre sont absentes');
  ok('panneau : export INSERT SQL (table qualifiée) respectant le filtre saisi', `${sqlTxt.split('\n').length} lignes de SQL`);

  // annulation depuis la barre de progression : fichier partiel supprimé
  page = await preview('gros');
  const f3 = path.join(tmp, 'annule.csv');
  global.__picks = ['CSV', 'Toute la table']; global.__saveUri = { fsPath: f3, scheme: 'file' }; global.__infos = []; global.__cancelNow = true;
  exportBtn(page).click();
  await until(() => (global.__infos || []).some((m) => /Export annulé/.test(m)), 'annulation');
  global.__cancelNow = false;
  assert.equal(fs.existsSync(f3), false);
  ok('annulation : message affiché, fichier partiel supprimé');

  // page affichée seulement : lignes de la page, pas la table
  page = await preview('gros');
  const f4 = path.join(tmp, 'page.csv');
  global.__picks = ['CSV', 'Page affichée']; global.__written = undefined; global.__saveUri = { fsPath: f4 };
  exportBtn(page).click();
  await until(() => global.__written, 'csv page');
  assert.equal(Buffer.from(global.__written.c).toString('utf8').trim().split('\r\n').length, 201);
  ok('« Page affichée » : 200 lignes + en-tête seulement');

  // résultat de requête libre : INSERT SQL avec nom de table demandé
  panel.showResult('test', 'SELECT 1', await driver.query(`SELECT id, nom FROM ${T('shop', 'produits')} WHERE id <= 2 ORDER BY id`), [], CFG.type);
  page = mount();
  global.__picks = ['INSERT SQL']; global.__inputs = ['ma_table']; global.__written = undefined; global.__saveUri = { fsPath: path.join(tmp, 'r.sql') };
  exportBtn(page).click();
  await until(() => global.__written, 'sql requête');
  const rq = Buffer.from(global.__written.c).toString('utf8');
  assert.ok(rq.startsWith(`INSERT INTO ${q('ma_table')} (${q('id')}, ${q('nom')}) VALUES`) && rq.includes("'Alpha'"), rq);
  ok('résultat de requête libre : INSERT SQL avec le nom de table demandé');

  // ------------------------------------------------------------ filtres par colonne, pagination par clé
  console.log('Filtres par colonne et pagination par clé');
  await db(`CREATE TABLE ${T('shop', 'kk')} (a int, b int, nom ${KIND === 'pg' ? 'text' : 'VARCHAR(30)'}, prix ${KIND === 'pg' ? 'numeric(8,2)' : 'DECIMAL(8,2)'}, PRIMARY KEY (a, b))`);
  const kv = [];
  for (let a = 1; a <= 5; a++) { for (let b = 1; b <= 7; b++) { kv.push(`(${a}, ${b}, '${(a + b) % 3 === 0 ? 'Dupont' : 'Martin'} ${a}-${b}', ${a * 10 + b})`); } }
  await db(`INSERT INTO ${T('shop', 'kk')} VALUES ${kv.join(',')}`);
  const kcols = await driver.listColumns('shop', 'kk');
  const kb = { dbType: CFG.type, container: 'shop', table: 'kk', columns: kcols, pageSize: 10, offset: 0 };
  const count = async (filter) => { const c = buildCountQuery({ ...kb, filter }); return Number((await db(c.sql, c.params)).rows[0][0]); };
  assert.equal(await count('prix > 40'), 14);
  assert.equal(await count('prix >= 41 ; nom contient dupont'), 5);
  assert.equal(await count("nom commence par 'Martin 1'"), 5);
  assert.equal(await count('nom finit par 7'), 5);
  assert.equal(await count('a = 2 ; b != 3'), 6);
  assert.equal(await count('nom vide'), 0);
  assert.equal(await count('nom non vide'), 35);
  assert.equal(await count('dupont'), 12, 'sans condition : recherche globale');
  assert.equal(await count('prix > 1000 ; martin'), 0, 'condition + recherche globale combinées');
  assert.deepEqual(parseFilter('prix > 20 ; zzz', kcols), { conditions: [{ column: 'prix', op: '>', value: '20' }], term: 'zzz' });
  assert.deepEqual(parseFilter('prixx > 20', kcols).conditions, []);
  ok('conditions par colonne (>, >=, !=, contient, commence, finit, vide) + recherche globale');

  // pagination par clé composite : mêmes lignes que par OFFSET
  assert.deepEqual(keysetColumns({ ...kb, sort: undefined }).map((c) => c.name), ['a', 'b']);
  assert.equal(keysetColumns({ ...kb, sort: { column: 'nom', dir: 'asc' } }), null);
  const viaOffset = [];
  for (let off = 0; off < 35; off += 10) { const g = buildPageQuery({ ...kb, offset: off }); viaOffset.push(...(await db(g.sql, g.params)).rows.slice(0, 10).map((r) => r.slice(0, 2).join('/'))); }
  const viaKeys = [];
  let after;
  for (let i = 0; i < 4; i++) {
    const g = buildPageQuery({ ...kb, offset: i * 10, after });
    assert.ok(i === 0 || !/OFFSET [1-9]/.test(g.sql), g.sql);
    const rows = (await db(g.sql, g.params)).rows.slice(0, 10);
    viaKeys.push(...rows.map((r) => r.slice(0, 2).join('/')));
    after = [rows[rows.length - 1][0], rows[rows.length - 1][1]];
  }
  assert.deepEqual(viaKeys, viaOffset);
  assert.equal(viaKeys.length, 35);
  const fq = buildPageQuery({ ...kb, offset: 10, filter: 'prix > 30', after: [3, 7] });
  const fr = (await db(fq.sql, fq.params)).rows.map((r) => r.slice(0, 2).join('/'));
  assert.deepEqual(fr.slice(0, 3), ['4/1', '4/2', '4/3']);
  ok('pagination par clé composite identique à OFFSET, sans OFFSET, combinée au filtre');

  // ------------------------------------------------------------ EXPLAIN
  console.log('EXPLAIN');
  const sel = `SELECT * FROM ${T('shop', 'kk')} WHERE a = 2 AND prix > 20`;
  for (const analyze of [false, true]) {
    const ex = explainSql(CFG.type, sel, analyze);
    let raw;
    try { raw = await db(ex.primary); } catch (e) { if (!ex.fallback) { throw e; } raw = await db(ex.fallback); }
    const plan = planToResult(CFG.type, raw, analyze);
    assert.ok(plan.rows.length >= 1 && plan.columns.length >= 1, JSON.stringify(plan));
    if (KIND === 'pg') {
      assert.equal(plan.columns[0], 'Étape');
      assert.ok(plan.rows.some((r) => /Scan/.test(r[0])), JSON.stringify(plan.rows));
      if (analyze) { assert.ok(plan.rows.some((r) => r[0] === 'Exécution (ms)')); }
    }
    ok(`EXPLAIN${analyze ? ' ANALYZE' : ''} : ${plan.rows.length} ligne(s) de plan`);
  }
  const before = Number((await db(`SELECT COUNT(*) FROM ${T('shop', 'kk')}`)).rows[0][0]);
  if (KIND === 'pg') {
    await db(explainSql('postgres', `DELETE FROM ${T('shop', 'kk')} WHERE a = 5`, true).primary);
    const after = Number((await db(`SELECT COUNT(*) FROM ${T('shop', 'kk')}`)).rows[0][0]);
    assert.equal(after, before - 7, 'EXPLAIN ANALYZE exécute vraiment l\'écriture (d\'où la confirmation)');
    ok('EXPLAIN ANALYZE d\'un DELETE exécute bien l\'écriture (confirmation demandée côté extension)');
  }

  // nettoyage
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const t of ['produits_copie', 'piege', 'piege2', 'gros', 'kk']) { await db(`DROP TABLE ${T('shop', t)}`); }
  await db(`DROP VIEW ${T('shop', 'v_chers')}`);
  await db(KIND === 'pg' ? 'DROP SCHEMA shop2 CASCADE' : 'DROP DATABASE shop2');
  console.log(`\n${passed} vérifications OK (${KIND})`);
  await driver.dispose();
})().catch(async (err) => { console.error('\n✗ ÉCHEC :', err.stack || err.message); try { await driver.dispose(); } catch {} process.exit(1); });

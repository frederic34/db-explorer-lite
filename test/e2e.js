// Test de bout en bout : page (jsdom) -> ResultsPanel -> pilote -> vraie base.
const assert = require('assert');
const { JSDOM } = require('jsdom');
const { createDriver } = require('../.test-build/drivers.js');
const { ResultsPanel } = require('../.test-build/panel.js');

const KIND = process.argv[2];
const { PG, MY, requireDb } = require('./config');
const { seed } = require('./seed');
const CFG = (KIND === 'pg' ? PG : MY).cfg;
const PW = (KIND === 'pg' ? PG : MY).password;
const SCHEMA = 'shop';
const q = (n) => (KIND === 'pg' ? `"${n}"` : `\`${n}\``);
const T = (n) => `${q(SCHEMA)}.${q(n)}`;

let passed = 0;
const ok = (label, extra = '') => { passed++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`); };
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
async function until(cond, label, timeout = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (cond()) return; await tick(); }
  throw new Error('délai dépassé : ' + label);
}

const nrep = () => global.__replies.filter((m) => m.type === 'opResult').length;
const opts = { maxRows: () => 5000, showSystem: () => false };
const driver = createDriver(CFG, PW, opts);
const panel = new ResultsPanel();

async function db(sql, params) { return driver.query(sql, params); }
async function count(table) { return Number((await db(`SELECT COUNT(*) FROM ${T(table)}`)).rows[0][0]); }
async function row(table, where) { return (await db(`SELECT * FROM ${T(table)} WHERE ${where}`)).rows[0]; }

// Équivalent de la commande « Afficher les données » de extension.ts
async function preview(table, limit = 200, isView = false) {
  const tableColumns = await driver.listColumns(SCHEMA, table);
  await panel.openTable({ dbType: CFG.type, container: SCHEMA, table, tableColumns, getDriver: async () => driver,
    connectionName: CFG.name, isView, pageSize: limit });
  return mount(tableColumns.map((c) => c.name));
}

function mount(columns) {
  const p = global.__vsPanels[0];
  const dom = new JSDOM(p.html, { runScripts: 'dangerously', beforeParse(w) {
    w.acquireVsCodeApi = () => ({ postMessage: (m) => { p.handlers.forEach((h) => h(m)); } });
  } });
  global.__vsWin = dom.window;
  const d = dom.window.document; const w = dom.window;
  const page = {
    d, w, columns,
    col: (name) => columns.indexOf(name),
    trs: () => [...d.querySelectorAll('tbody tr')],
    rowById: (id) => page.trs().find((tr) => tr.children[2].textContent === String(id)),
    cell: (tr, name) => tr.children[2 + columns.indexOf(name)],
    ids: () => page.trs().map((tr) => tr.children[2].textContent),
    op: () => ({ cls: d.getElementById('opmsg').className, text: d.getElementById('opmsg').textContent }),
    delBtn: () => [...d.querySelectorAll('.bar button')].find((b) => /Supprimer/.test(b.textContent)),
    pencil: (tr) => tr.querySelector('td.actions button.icon'),
    type: (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); },
    check: (tr, on = true) => { const cb = tr.querySelector('input.sel'); cb.checked = on; cb.dispatchEvent(new w.Event('change', { bubbles: true })); },
    input: (tr, name) => page.cell(tr, name).querySelector('input[type=text], textarea'),
    nul: (tr, name) => page.cell(tr, name).querySelector('label input'),
    editing: () => d.querySelector('tr.editing:not(.inserting)'),
    save: () => d.querySelector('tr.editing td.actions button.icon').click(),
    waitDone: async (label) => { await until(() => ['ok', 'ko', ''].includes(page.op().cls) && !d.querySelector('tr.editing input:disabled') && !page.delBtn()?.disabled || page.op().cls === 'ko' || page.op().cls === 'ok', label); },
  };
  return page;
}
const waitOp = async (page, cls, label) => until(() => page.op().cls === cls, label || ('message ' + cls));

(async () => {
  console.log(`\n=== ${KIND === 'pg' ? 'PostgreSQL' : 'MariaDB'} ===`);
  try {
    await seed(KIND, driver);
  } catch (e) {
    if (!requireDb) {
      console.log(`  (ignoré : base injoignable — ${e.message}. Lancez « docker compose -f test/docker-compose.yml up -d --wait »)`);
      await driver.dispose().catch(() => {});
      process.exit(0);
    }
    throw e;
  }

  // ---------------------------------------------------------------- planEditing / grille
  console.log('Grille et lecture seule');
  let pg = await preview('produits');
  const cols = pg.columns;
  assert.ok(pg.d.querySelector('thead input[type=checkbox]'));
  assert.equal(pg.trs().length, 5);
  assert.ok(pg.trs().every((tr) => tr.querySelector('input.sel') && tr.querySelector('button.icon')));
  ok('cases à cocher et crayon sur chaque ligne', `${pg.trs().length} lignes`);
  assert.ok(pg.d.querySelectorAll('thead th')[2].textContent.includes('🔑'), 'clé primaire marquée');
  ok('colonne clé primaire repérée (🔑)');

  // lecture seule : sans clé primaire
  let ro = await preview('sanspk');
  assert.equal(ro.d.querySelectorAll('input[type=checkbox]').length, 0);
  assert.ok(/Lecture seule : cette table n'a pas de clé primaire/.test(ro.d.getElementById('root').textContent));
  ok('table sans clé primaire : lecture seule + raison affichée');

  // lecture seule : vue / requête libre
  ro = await preview('produits', 200, true);
  assert.equal(ro.d.querySelectorAll('input[type=checkbox]').length, 0);
  assert.ok(/Lecture seule : les vues/.test(ro.d.getElementById('root').textContent));
  panel.showResult('X', 'SELECT 1', { columns: ['a'], rows: [['1']], rowCount: 1, truncated: false, durationMs: 1 });
  ro = mount(['a']);
  assert.equal(ro.d.querySelectorAll('input[type=checkbox]').length, 0);
  assert.ok(!/Lecture seule/.test(ro.d.getElementById('root').textContent));
  ok('vue et requête libre : aucune édition possible');

  // ---------------------------------------------------------------- édition d'une ligne
  console.log('Édition d\'une ligne');
  pg = await preview('produits');
  let tr = pg.rowById(2);
  pg.pencil(tr).click();
  tr = pg.editing();
  assert.ok(tr, 'ligne en édition');
  assert.equal(pg.cell(tr, 'id').querySelector('input'), null, 'PK non éditable');
  assert.ok(pg.input(tr, 'nom') && pg.input(tr, 'prix') && pg.input(tr, 'note'));
  assert.equal(pg.nul(tr, 'nom'), null, 'NOT NULL : pas de case NULL');
  assert.ok(pg.nul(tr, 'note'), 'colonne nullable : case NULL');
  assert.equal(pg.nul(tr, 'note').checked, true, 'note vaut NULL au départ');
  if (KIND === 'pg') {
    assert.equal(pg.cell(tr, 'tags').querySelector('input, textarea'), null, 'tableau non éditable');
  }
  assert.equal(pg.cell(tr, 'bin').querySelector('input, textarea'), null, 'binaire non éditable');
  ok('formulaire de ligne : PK, binaire' + (KIND === 'pg' ? ' et tableau' : '') + ' verrouillés, NULL proposé seulement si autorisé');

  const evil = "Café ☕ \"x\" '); DROP TABLE " + T('produits') + "; --";
  pg.type(pg.input(tr, 'nom'), evil);
  pg.type(pg.input(tr, 'prix'), '19.9');
  pg.type(pg.input(tr, 'note'), 'ligne1\nligne2');
  pg.save();
  await waitOp(pg, 'ok', 'update ok');
  let r = await row('produits', 'id = 2');
  const c = (n) => cols.indexOf(n);
  assert.equal(r[c('nom')], evil);
  assert.equal(r[c('prix')], '19.90');
  assert.equal(r[c('note')], 'ligne1\nligne2');
  assert.equal(await count('produits'), 5, 'la table existe toujours');
  assert.equal(pg.cell(pg.rowById(2), 'prix').textContent, '19.90', 'valeur normalisée relue du serveur');
  assert.equal(pg.cell(pg.rowById(2), 'nom').textContent, evil);
  assert.equal(pg.editing(), null);
  ok('UPDATE appliqué en base, texte hostile stocké tel quel (pas d\'injection)', 'prix 19.9 → 19.90 relu du serveur');

  // mettre une valeur à NULL, rétablir '' ; modifier JSON, booléen, date
  tr = (pg.pencil(pg.rowById(3)).click(), pg.editing());
  assert.equal(pg.input(tr, 'note').value, '', 'chaîne vide ≠ NULL à l\'affichage');
  assert.equal(pg.nul(tr, 'note').checked, false);
  pg.nul(tr, 'note').checked = true; pg.nul(tr, 'note').dispatchEvent(new pg.w.Event('change', { bubbles: true }));
  pg.type(pg.input(tr, 'meta'), '{"k": [1, 2]}');
  pg.type(pg.input(tr, 'actif'), KIND === 'pg' ? 'false' : '0');
  pg.type(pg.input(tr, 'cree_le'), KIND === 'pg' ? '2026-12-25 10:30:00+00' : '2026-12-25 10:30:00');
  pg.save();
  await waitOp(pg, 'ok', 'update 2');
  r = await row('produits', 'id = 3');
  assert.equal(r[c('note')], null);
  assert.deepEqual(JSON.parse(r[c('meta')]), { k: [1, 2] });
  assert.equal(r[c('actif')], KIND === 'pg' ? 'false' : '0');
  assert.ok(r[c('cree_le')].startsWith('2026-12-25'));
  assert.ok(pg.cell(pg.rowById(3), 'note').classList.contains('null'));
  ok('NULL, JSON, booléen et date modifiés', `cree_le = ${r[c('cree_le')]}`);

  // NULL → '' : une chaîne vide est bien distincte de NULL
  tr = (pg.pencil(pg.rowById(2)).click(), pg.editing());
  pg.type(pg.input(tr, 'note'), '');
  pg.nul(tr, 'note') && (pg.nul(tr, 'note').checked = false);
  pg.save();
  await waitOp(pg, 'ok', 'update vide');
  r = await row('produits', 'id = 2');
  assert.equal(r[c('note')], '');
  ok("valeur '' enregistrée comme chaîne vide (et non NULL)");

  // aucune modification : pas d'aller-retour
  const before = nrep();
  tr = (pg.pencil(pg.rowById(4)).click(), pg.editing());
  pg.save();
  await tick(60);
  assert.equal(pg.editing(), null);
  assert.equal(nrep(), before);
  ok('validation sans changement : édition fermée, aucune requête envoyée');

  // Échap annule / Entrée valide
  tr = (pg.pencil(pg.rowById(4)).click(), pg.editing());
  const nomInput = pg.input(tr, 'nom');
  pg.type(nomInput, 'ANNULÉ');
  nomInput.dispatchEvent(new pg.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(pg.editing(), null);
  assert.equal((await row('produits', 'id = 4'))[c('nom')], 'Delta');
  tr = (pg.pencil(pg.rowById(4)).click(), pg.editing());
  pg.type(pg.input(tr, 'nom'), 'Delta2');
  pg.input(tr, 'nom').dispatchEvent(new pg.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitOp(pg, 'ok', 'enter');
  assert.equal((await row('produits', 'id = 4'))[c('nom')], 'Delta2');
  ok('Échap annule sans toucher la base, Entrée enregistre');

  // valeur refusée par la base : erreur affichée, ligne toujours en édition, base inchangée
  tr = (pg.pencil(pg.rowById(5)).click(), pg.editing());
  pg.type(pg.input(tr, 'prix'), 'pas un nombre');
  pg.save();
  await waitOp(pg, 'ko', 'erreur prix');
  assert.ok(pg.editing(), 'reste en édition');
  assert.ok(!pg.editing().querySelector('input:disabled'), 'champs réactivés');
  assert.equal((await row('produits', 'id = 5'))[c('prix')], '50.00');
  ok('valeur invalide : erreur affichée, on reste en édition, base inchangée', pg.op().text.slice(0, 70));
  pg.editing().querySelector('td.actions button:nth-of-type(2)').click();
  assert.equal(pg.editing(), null);

  // ligne supprimée entre-temps par quelqu'un d'autre
  await db(`INSERT INTO ${T('produits')} (nom) VALUES ('Fantôme')`);
  pg = await preview('produits');
  const ghostId = pg.ids().map(Number).sort((a, b) => b - a)[0];
  await db(`DELETE FROM ${T('produits')} WHERE ${q('id')} = ${ghostId}`);
  tr = (pg.pencil(pg.rowById(ghostId)).click(), pg.editing());
  pg.type(pg.input(tr, 'nom'), 'trop tard');
  pg.save();
  await waitOp(pg, 'ko', 'ligne disparue');
  assert.ok(/annulée/.test(pg.op().text));
  ok('ligne supprimée par un tiers : opération annulée avec message clair');

  // ---------------------------------------------------------------- suppression
  console.log('Suppression');
  pg = await preview('produits');
  assert.equal(pg.delBtn().disabled, true);
  pg.check(pg.rowById(2)); pg.check(pg.rowById(3));
  assert.equal(pg.delBtn().disabled, false);
  assert.ok(/\(2\)/.test(pg.delBtn().textContent));
  ok('bouton Supprimer désactivé sans sélection, compteur (2) avec');

  // annulation de la confirmation
  global.__nextChoice = undefined; global.__modals = [];
  pg.delBtn().click();
  await until(() => global.__modals.length === 1, 'modale');
  await tick(60);
  assert.equal(await count('produits'), 5);
  assert.equal(pg.trs().length, 5);
  assert.equal(pg.delBtn().disabled, false);
  assert.ok(/Supprimer 2 lignes de « produits »/.test(global.__modals[0]), global.__modals[0]);
  ok('confirmation refusée : rien n\'est supprimé, interface de nouveau active', global.__modals[0]);

  // clé étrangère : atomicité (une ligne bloquée => aucune supprimée)
  pg.check(pg.rowById(1));            // Alpha a un enfant
  global.__nextChoice = 'Supprimer';
  pg.delBtn().click();
  await waitOp(pg, 'ko', 'FK');
  assert.equal(await count('produits'), 5, 'rien supprimé');
  assert.equal(pg.trs().length, 5);
  ok('contrainte de clé étrangère : erreur affichée, suppression annulée en bloc', pg.op().text.slice(0, 80).replace(/\n/g, ' '));

  // suppression réussie
  pg.check(pg.rowById(1), false);
  assert.ok(/\(2\)/.test(pg.delBtn().textContent));
  pg.delBtn().click();
  await waitOp(pg, 'ok', 'delete ok');
  assert.equal(await count('produits'), 3);
  assert.deepEqual(pg.ids().sort(), ['1', '4', '5']);
  assert.ok(/2 lignes supprimées/.test(pg.op().text));
  assert.ok(/2 lignes supprimées/.test(pg.d.querySelector('.top').textContent));
  assert.equal(pg.delBtn().disabled, true);
  ok('2 lignes supprimées en base et retirées de la grille', pg.op().text);

  // filtre : seules les lignes visibles restent sélectionnées
  pg.check(pg.rowById(4)); pg.check(pg.rowById(5));
  const f = pg.d.querySelector('input[type=search]');
  pg.type(f, 'écho');
  await until(() => pg.ids().join() === '5' || pg.op().cls === 'ko', 'filtre serveur'); assert.equal(pg.op().text, '', pg.op().text);
  assert.equal(pg.delBtn().disabled, true, 'changer de page / de filtre efface la sélection');
  pg.type(f, 'zzz');
  await until(() => pg.ids().length === 0, 'filtre zzz');
  assert.equal(pg.delBtn().disabled, true);
  pg.type(f, '');
  await until(() => pg.ids().length === 3, 'filtre vidé');
  ok('filtre serveur : la sélection est effacée au changement de page (on ne supprime que ce qu\'on voit)');

  // tout sélectionner
  const selAll = pg.d.querySelector('thead input[type=checkbox]');
  selAll.checked = true; selAll.dispatchEvent(new pg.w.Event('change', { bubbles: true }));
  assert.ok(/\(3\)/.test(pg.delBtn().textContent));
  selAll.checked = false; selAll.dispatchEvent(new pg.w.Event('change', { bubbles: true }));
  assert.equal(pg.delBtn().disabled, true);
  ok('case « tout sélectionner » (sélection et désélection)');

  // jeton périmé : un message d'une ancienne page est ignoré
  const nb = nrep();
  global.__vsPanels[0].handlers.forEach((h) => h({ type: 'deleteRows', token: 'périmé', rowIndexes: [0, 1, 2] }));
  await tick(60);
  assert.equal(nrep(), nb); assert.equal(await count('produits'), 3);
  ok('message d\'une page périmée ignoré');

  // ---------------------------------------------------------------- clé composite
  console.log('Clé primaire composite');
  let lg = await preview('lignes');
  assert.equal(lg.d.querySelectorAll('thead th')[2].textContent.includes('🔑'), true);
  assert.equal(lg.d.querySelectorAll('thead th')[3].textContent.includes('🔑'), true);
  tr = (lg.pencil(lg.trs().find((t) => t.children[2].textContent === '2' && t.children[3].textContent === '1')).click(), lg.editing());
  lg.type(lg.input(tr, 'qte'), '77');
  lg.save();
  await waitOp(lg, 'ok', 'update composite');
  assert.equal((await row('lignes', `${q('cmd')} = 2 AND ${q('ligne')} = 1`))[2], '77');
  assert.equal((await row('lignes', `${q('cmd')} = 1 AND ${q('ligne')} = 1`))[2], '5');
  ok('UPDATE sur (cmd, ligne) : seule la bonne ligne change');

  lg.check(lg.trs().find((t) => t.children[2].textContent === '1' && t.children[3].textContent === '2'));
  lg.check(lg.trs().find((t) => t.children[2].textContent === '2' && t.children[3].textContent === '2'));
  global.__nextChoice = 'Supprimer';
  lg.delBtn().click();
  await waitOp(lg, 'ok', 'delete composite');
  const left = (await db(`SELECT ${q('cmd')}, ${q('ligne')} FROM ${T('lignes')} ORDER BY 1, 2`)).rows.map((x) => x.join('-'));
  assert.deepEqual(left, ['1-1', '2-1']);
  ok('DELETE sur clé composite : (1,2) et (2,2) supprimées, (1,1) et (2,1) conservées');

  // ---------------------------------------------------------------- gros lot + CSV
  console.log('Gros lot et export');
  if (KIND === 'pg') {
    await db(`CREATE TABLE ${T('gros')} (id int PRIMARY KEY, v text)`);
    await db(`INSERT INTO ${T('gros')} SELECT g, 'v' || g FROM generate_series(1, 1200) g`);
  } else {
    await db(`CREATE TABLE ${T('gros')} (id int PRIMARY KEY, v VARCHAR(20)) ENGINE=InnoDB`);
    await db(`INSERT INTO ${T('gros')} SELECT seq, CONCAT('v', seq) FROM (SELECT @r2 := @r2 + 1 AS seq FROM information_schema.columns a, information_schema.columns b, (SELECT @r2 := 0) v LIMIT 1200) t`);
  }
  let big = await preview('gros', 1500);
  assert.equal(big.trs().length, 1000, 'taille de page plafonnée à 1000');
  const all = big.d.querySelector('thead input[type=checkbox]');
  all.checked = true; all.dispatchEvent(new big.w.Event('change', { bubbles: true }));
  assert.ok(/\(1000\)/.test(big.delBtn().textContent));
  global.__nextChoice = 'Supprimer'; global.__modals = [];
  big.delBtn().click();
  await waitOp(big, 'ok', 'gros delete');
  assert.equal(await count('gros'), 200);
  ok('1000 lignes supprimées d\'un coup (2 lots, une seule transaction)');

  // CSV : reflète les modifications et omet les lignes supprimées
  pg = await preview('produits');
  pg.check(pg.rowById(5));
  global.__nextChoice = 'Supprimer';
  pg.delBtn().click();
  await waitOp(pg, 'ok', 'delete avant csv');
  global.__saveUri = { fsPath: '/tmp/x.csv' };
  global.__written = undefined;
  [...pg.d.querySelectorAll('.bar button')].find((b) => /CSV/.test(b.textContent)).click();
  await until(() => global.__written, 'csv');
  const csv = Buffer.from(global.__written.c).toString('utf8');
  assert.ok(!csv.includes('Écho'), 'ligne supprimée absente du CSV');
  assert.ok(csv.includes('Delta2'), 'ligne modifiée présente avec sa nouvelle valeur');
  ok('export CSV : lignes supprimées omises, valeurs modifiées incluses', `${csv.trim().split('\r\n').length - 1} lignes`);

  // ---------------------------------------------------------------- bas niveau
  console.log('Pilote : transaction');
  const lignesBefore = await count('lignes');
  await assert.rejects(
    driver.executeBatch([
      { sql: `UPDATE ${T('lignes')} SET ${q('qte')} = ${KIND === 'pg' ? '$1' : '?'} WHERE ${q('qte')} > ${KIND === 'pg' ? '$2' : '?'}`, params: [999, 0], expect: 1 },
    ]),
    /annulée/,
  );
  assert.equal((await row('lignes', `${q('cmd')} = 1 AND ${q('ligne')} = 1`))[2], '5');
  assert.equal((await row('lignes', `${q('cmd')} = 2 AND ${q('ligne')} = 1`))[2], '77');
  ok('expect non respecté (2 lignes au lieu d\'1) : rollback, rien modifié');

  await assert.rejects(driver.executeBatch([
    { sql: `UPDATE ${T('lignes')} SET ${q('qte')} = 4242 WHERE ${q('cmd')} = 1 AND ${q('ligne')} = 1`, params: [], expect: 1 },
    { sql: `INSERT INTO ${T('lignes')} VALUES (1, 1, 1)`, params: [] },          // doublon de clé
  ]));
  assert.equal((await row('lignes', `${q('cmd')} = 1 AND ${q('ligne')} = 1`))[2], '5');
  ok('échec de la 2e instruction : la 1re est annulée aussi (tout ou rien)');

  if (KIND === 'my') {
    const res = await driver.executeBatch([{ sql: `UPDATE ${T('lignes')} SET ${q('qte')} = qte WHERE ${q('cmd')} = 1 AND ${q('ligne')} = 1`, params: [], expect: 1 }]);
    assert.deepEqual(res, [1]);
    ok('MariaDB : un UPDATE qui réécrit la même valeur compte bien 1 ligne (FOUND_ROWS)');
  }


  // ================================================================ INSERTION
  console.log('Insertion');
  const addBtnOf = (pg_) => [...pg_.d.querySelectorAll('.bar button')].find((b) => /Ajouter/.test(b.textContent));
  const insRow = (pg_) => pg_.d.querySelector('tr.inserting');
  const icell = (pg_, name) => insRow(pg_).children[2 + pg_.columns.indexOf(name)];
  const ta = (pg_, name) => icell(pg_, name).querySelector('textarea');
  const flag = (pg_, name, label) => [...icell(pg_, name).querySelectorAll('label')].find((l) => l.textContent === label)?.querySelector('input');
  const fire = (pg_, el, type) => el.dispatchEvent(new pg_.w.Event(type, { bubbles: true }));
  const okBtn = (pg_) => insRow(pg_).querySelector('td.actions button.icon');
  const koBtn = (pg_) => insRow(pg_).querySelectorAll('td.actions button.icon')[1];

  let ins = await preview('produits');
  const maxId = Math.max(...ins.ids().map(Number));
  addBtnOf(ins).click();
  assert.ok(insRow(ins), 'ligne de saisie ouverte');
  assert.equal(insRow(ins), ins.d.querySelector('tbody tr:first-child'), 'en tête de grille');
  assert.equal(ta(ins, 'bin'), null, 'binaire non saisissable');
  if (KIND === 'pg') { assert.equal(ta(ins, 'tags'), null, 'tableau non saisissable'); }
  assert.equal(ta(ins, 'id').placeholder, '(défaut)');
  assert.equal(flag(ins, 'id', 'défaut').checked, true);
  assert.equal(ta(ins, 'nom').placeholder, '(obligatoire)');
  assert.equal(flag(ins, 'nom', 'NULL'), undefined, 'NOT NULL : pas de case NULL');
  assert.equal(ta(ins, 'note').placeholder, 'NULL');
  assert.equal(flag(ins, 'note', 'NULL').checked, true, 'nullable sans défaut : NULL par défaut');
  ok('ligne de saisie en tête : défaut / NULL / obligatoire proposés par colonne, binaire' + (KIND === 'pg' ? ' et tableau' : '') + ' verrouillés');

  // champ obligatoire manquant : rien n'est envoyé
  let nbI = nrep();
  okBtn(ins).click();
  await tick(60);
  assert.equal(ins.op().cls, 'ko');
  assert.ok(/« nom » est obligatoire/.test(ins.op().text), ins.op().text);
  assert.equal(nrep(), nbI);
  assert.ok(insRow(ins), 'le formulaire reste ouvert');
  ok('colonne obligatoire non renseignée : message, rien envoyé', ins.op().text);

  // insertion minimale : seul « nom » est renseigné, le reste prend ses défauts
  const hostile = "Nouveau \"produit\" ☕ '); DROP TABLE " + T('produits') + "; --";
  const countBefore = await count('produits');
  ins.type(ta(ins, 'nom'), hostile);
  ta(ins, 'nom').dispatchEvent(new ins.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitOp(ins, 'ok', 'insert ok');
  assert.equal(await count('produits'), countBefore + 1);
  assert.equal(await count('produits') > 0, true);
  const first = ins.d.querySelector('tbody tr:first-child');
  const newId = Number(first.children[2].textContent);
  assert.ok(newId > maxId, 'id auto-généré');
  let rr = await row('produits', `${q('id')} = ${newId}`);
  assert.equal(rr[cols.indexOf('nom')], hostile);
  assert.equal(rr[cols.indexOf('actif')], KIND === 'pg' ? 'true' : '1', 'valeur par défaut appliquée');
  assert.ok(rr[cols.indexOf('cree_le')], 'défaut de date appliqué');
  assert.equal(rr[cols.indexOf('prix')], null);
  assert.equal(ins.cell(first, 'actif').textContent, KIND === 'pg' ? 'true' : '1', 'la grille affiche les valeurs réelles');
  assert.ok(ins.cell(first, 'prix').classList.contains('null'));
  assert.equal(insRow(ins), null, 'ligne de saisie refermée');
  assert.ok(/1 ligne ajoutée/.test(ins.d.querySelector('.top').textContent));
  ok('INSERT : id auto-généré, défauts appliqués, texte hostile stocké tel quel', `id = ${newId}, actif = ${rr[cols.indexOf('actif')]}`);

  // valeurs explicites, y compris NULL et défaut décoché
  addBtnOf(ins).click();
  ins.type(ta(ins, 'nom'), 'Complet');
  ins.type(ta(ins, 'prix'), '7.5');
  assert.equal(flag(ins, 'prix', 'NULL').checked, false, 'saisir décoche NULL');
  flag(ins, 'meta', 'NULL').checked = false; fire(ins, flag(ins, 'meta', 'NULL'), 'change');
  ins.type(ta(ins, 'meta'), '{"x": 1}');
  ins.type(ta(ins, 'actif'), KIND === 'pg' ? 'false' : '0');
  assert.equal(flag(ins, 'actif', 'défaut').checked, false, 'saisir décoche défaut');
  ins.type(ta(ins, 'note'), 'avec note');
  insRow(ins) && okBtn(ins).click();
  await waitOp(ins, 'ok', 'insert complet');
  const id2 = Number(ins.d.querySelector('tbody tr:first-child').children[2].textContent);
  rr = await row('produits', `${q('id')} = ${id2}`);
  assert.equal(rr[cols.indexOf('prix')], '7.50');
  assert.deepEqual(JSON.parse(rr[cols.indexOf('meta')]), { x: 1 });
  assert.equal(rr[cols.indexOf('actif')], KIND === 'pg' ? 'false' : '0');
  assert.equal(rr[cols.indexOf('note')], 'avec note');
  assert.ok(/2 lignes ajoutées/.test(ins.d.querySelector('.top').textContent));
  ok('valeurs saisies enregistrées (nombre, JSON, booléen, texte)', `prix 7.5 → ${rr[cols.indexOf('prix')]}`);

  // retour au défaut / NULL via les cases
  addBtnOf(ins).click();
  ins.type(ta(ins, 'nom'), 'Cases');
  ins.type(ta(ins, 'actif'), KIND === 'pg' ? 'false' : '0');
  flag(ins, 'actif', 'défaut').checked = true; fire(ins, flag(ins, 'actif', 'défaut'), 'change');
  assert.equal(ta(ins, 'actif').value, '');
  ins.type(ta(ins, 'note'), 'sera annulée');
  flag(ins, 'note', 'NULL').checked = true; fire(ins, flag(ins, 'note', 'NULL'), 'change');
  assert.equal(ta(ins, 'note').value, '');
  okBtn(ins).click();
  await waitOp(ins, 'ok', 'insert cases');
  const id3 = Number(ins.d.querySelector('tbody tr:first-child').children[2].textContent);
  rr = await row('produits', `${q('id')} = ${id3}`);
  assert.equal(rr[cols.indexOf('actif')], KIND === 'pg' ? 'true' : '1', 'retour au défaut');
  assert.equal(rr[cols.indexOf('note')], null, 'NULL explicite');
  ok('cases « défaut » et « NULL » : la valeur tapée est abandonnée');

  // annulation (bouton et Échap) ; ouverture/fermeture croisées avec l'édition
  const cnt = await count('produits');
  addBtnOf(ins).click();
  ins.type(ta(ins, 'nom'), 'jamais inséré');
  koBtn(ins).click();
  assert.equal(insRow(ins), null);
  addBtnOf(ins).click();
  ta(ins, 'nom').dispatchEvent(new ins.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(insRow(ins), null);
  assert.equal(await count('produits'), cnt);
  addBtnOf(ins).click();
  ins.pencil(ins.rowById(1)).click();
  assert.equal(insRow(ins), null, 'modifier une ligne ferme la saisie');
  assert.ok(ins.editing());
  addBtnOf(ins).click();
  assert.equal(ins.editing(), null, 'ajouter ferme la modification');
  assert.ok(insRow(ins));
  koBtn(ins).click();
  ok('annulation par ✗ et Échap ; saisie et modification s\'excluent mutuellement');

  // supprimer une ligne tout juste insérée (cohérence des indices)
  ins.check(ins.rowById(newId));
  global.__nextChoice = 'Supprimer';
  ins.delBtn().click();
  await waitOp(ins, 'ok', 'suppression de la ligne insérée');
  assert.equal(await row('produits', `${q('id')} = ${newId}`), undefined);
  assert.equal(ins.rowById(newId), undefined);
  ok('une ligne insérée peut être supprimée aussitôt');

  // clé composite saisie à la main + doublon
  let lg2 = await preview('lignes');
  addBtnOf(lg2).click();
  assert.equal(ta(lg2, 'cmd').placeholder, '(obligatoire)');
  lg2.type(ta(lg2, 'cmd'), '3'); lg2.type(ta(lg2, 'ligne'), '1');
  okBtn(lg2).click(); await tick(60);
  assert.ok(/« qte » est obligatoire/.test(lg2.op().text));
  lg2.type(ta(lg2, 'qte'), '9');
  okBtn(lg2).click();
  await waitOp(lg2, 'ok', 'insert composite');
  const top = lg2.d.querySelector('tbody tr:first-child');
  assert.deepEqual([top.children[2].textContent, top.children[3].textContent, top.children[4].textContent], ['3', '1', '9']);
  assert.equal((await row('lignes', `${q('cmd')} = 3 AND ${q('ligne')} = 1`))[2], '9');
  ok('clé composite : ligne (3,1) insérée et retrouvée par sa clé');

  const rowsInGrid = lg2.trs().length;
  addBtnOf(lg2).click();
  lg2.type(ta(lg2, 'cmd'), '3'); lg2.type(ta(lg2, 'ligne'), '1'); lg2.type(ta(lg2, 'qte'), '1');
  okBtn(lg2).click();
  await waitOp(lg2, 'ko', 'doublon');
  assert.ok(insRow(lg2), 'formulaire conservé après l\'erreur');
  assert.ok(!insRow(lg2).querySelector('textarea:disabled'), 'champs réactivés');
  assert.equal(lg2.trs().length, rowsInGrid + 1, 'seule la ligne de saisie s\'ajoute');
  assert.equal((await row('lignes', `${q('cmd')} = 3 AND ${q('ligne')} = 1`))[2], '9', 'première ligne intacte');
  ok('doublon de clé : erreur affichée, formulaire conservé, base inchangée', lg2.op().text.slice(0, 60).replace(/\n/g, ' '));
  koBtn(lg2).click();

  // aucune colonne à renseigner : INSERT ... DEFAULT VALUES
  const td = await preview('tout_defaut');
  addBtnOf(td).click();
  okBtn(td).click();
  await waitOp(td, 'ok', 'default values');
  const trd = td.d.querySelector('tbody tr:first-child');
  assert.equal(td.cell(trd, 'a').textContent, '5');
  assert.equal(await count('tout_defaut'), 1);
  ok('table entièrement par défaut : INSERT sans colonnes (' + (KIND === 'pg' ? 'DEFAULT VALUES' : '() VALUES ()') + ')', 'a = 5');

  // colonne générée : non saisissable, non modifiable, valeur relue
  const gn = await preview('gen');
  addBtnOf(gn).click();
  assert.equal(ta(gn, 'g'), null);
  assert.equal(icell(gn, 'g').textContent, '—');
  gn.type(ta(gn, 'a'), '10');
  okBtn(gn).click();
  await waitOp(gn, 'ok', 'gen insert');
  const tg = gn.d.querySelector('tbody tr:first-child');
  assert.equal(gn.cell(tg, 'g').textContent, '20', 'colonne générée relue');
  gn.pencil(tg).click();
  const eg = gn.editing();
  assert.equal(gn.cell(eg, 'g').querySelector('textarea'), null, 'colonne générée non modifiable');
  gn.type(gn.cell(eg, 'a').querySelector('textarea'), '11');
  gn.save();
  await waitOp(gn, 'ok', 'gen update');
  assert.equal(gn.cell(gn.d.querySelector('tbody tr:first-child'), 'g').textContent, '22', 'génération recalculée et relue');
  ok('colonne générée : exclue de la saisie et de la modification, valeur recalculée affichée', 'a=10 → g=20, puis a=11 → g=22');

  // identité GENERATED ALWAYS (PostgreSQL)
  if (KIND === 'pg') {
    const idn = await preview('ident');
    addBtnOf(idn).click();
    assert.equal(icell(idn, 'id').textContent, '—');
    idn.type(ta(idn, 'label'), 'identité');
    okBtn(idn).click();
    await waitOp(idn, 'ok', 'identity');
    assert.equal(Number(idn.d.querySelector('tbody tr:first-child').children[2].textContent) >= 1, true);
    ok('PostgreSQL : identité GENERATED ALWAYS non saisissable, valeur générée relue');
  }

  // clé primaire générée par le serveur (UUID)
  const uu = await preview('uuids');
  addBtnOf(uu).click();
  assert.equal(ta(uu, 'id').placeholder, '(défaut)');
  uu.type(ta(uu, 'label'), 'u1');
  okBtn(uu).click();
  await waitOp(uu, 'ok', 'uuid');
  assert.equal(await count('uuids'), 1);
  if (KIND === 'pg') {
    const idc = uu.d.querySelector('tbody tr:first-child').children[2].textContent;
    assert.match(idc, /^[0-9a-f-]{36}$/);
    ok('PostgreSQL : UUID généré par le serveur relu via RETURNING', idc);
  } else {
    assert.ok(/Actualisez l'aperçu/.test(uu.op().text), uu.op().text);
    assert.equal(uu.trs().length, 0, 'pas de ligne inventée');
    ok('MariaDB : PK UUID inconnue du client → insertion confirmée, message « actualisez l\'aperçu », aucune ligne inventée');
  }

  // message d'une page périmée / valeurs invalides envoyées à la main
  nbI = nrep();
  global.__vsPanels[0].handlers.forEach((h) => h({ type: 'insertRow', token: 'périmé', values: { 1: 'x' } }));
  await tick(60);
  assert.equal(nrep(), nbI);
  const cur = await preview('produits');
  const c0 = await count('produits');
  const send = async (values) => { const before = nrep(); global.__vsPanels[0].handlers.forEach((h) => h({ type: 'insertRow', token: JSON.parse(cur.d.getElementById('data').textContent).token, values })); await until(() => nrep() > before, 'réponse'); return global.__replies.filter((m) => m.type === 'opResult').slice(-1)[0]; };
  let bad = await send({ [cols.indexOf('id')]: '999' });             // id : PK/défaut mais insertable → ok en théorie ; on teste plutôt un index hors plage
  await db(`DELETE FROM ${T('produits')} WHERE ${q('id')} = 999`);
  bad = await send({ 99: 'x' });
  assert.equal(bad.ok, false); assert.ok(/ne peut pas être renseignée/.test(bad.message));
  bad = await send({ [cols.indexOf('nom')]: null });
  assert.equal(bad.ok, false); assert.ok(/n'accepte pas NULL/.test(bad.message));
  bad = await send({ [cols.indexOf('nom')]: { x: 1 } });
  assert.equal(bad.ok, false);
  bad = await send({ [cols.indexOf('bin')]: 'abc' });
  assert.equal(bad.ok, false);
  assert.equal(await count('produits'), c0);
  ok('requêtes forgées refusées côté extension (colonne inconnue, NULL interdit, type invalide, colonne binaire)');


  // ================================================================ PAGINATION
  console.log('Pagination, tri et filtre côté serveur');
  const body = `n, n % 3, CASE WHEN n = 7 THEN 'a%b' WHEN n = 8 THEN 'a_b' ELSE 'Ligne ' || n END`;
  if (KIND === 'pg') {
    await db(`DROP TABLE IF EXISTS ${T('pag')}`);
    await db(`CREATE TABLE ${T('pag')} (id int PRIMARY KEY, grp int, txt text)`);
    await db(`INSERT INTO ${T('pag')} SELECT ${body} FROM generate_series(1, 250) n`);
  } else {
    await db(`DROP TABLE IF EXISTS ${T('pag')}`);
    await db(`CREATE TABLE ${T('pag')} (id int PRIMARY KEY, grp int, txt VARCHAR(50)) ENGINE=InnoDB`);
    await db(`INSERT INTO ${T('pag')} WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 250) SELECT n, n % 3, CASE WHEN n = 7 THEN 'a%b' WHEN n = 8 THEN 'a_b' ELSE CONCAT('Ligne ', n) END FROM s`);
  }
  const nPages = () => global.__replies.filter((m) => m.type === 'page').length;
  const pager = (pp) => pp.d.querySelector('.pager');
  const pbtn = (pp, title) => [...pager(pp).querySelectorAll('button')].find((b) => b.title === title);
  const pos = (pp) => pager(pp).querySelector('.pos').textContent;
  const sizeSel = (pp) => pp.d.querySelector('.pager ~ select, .bar select');
  const go = async (pp, fn) => { const n = nPages(); fn(); await until(() => nPages() > n, 'page'); };
  const settled = async (pp, re) => until(() => re.test(pos(pp)), 'position ' + re);
  const nums = (pp) => pp.trs().map((tr) => Number(tr.children[1].textContent));
  const tokenOf = (pp) => pp.w.document.getElementById('data').textContent; // jeton initial seulement
  const idsN = (pp) => pp.ids().map(Number);

  let pb = await preview('pag', 100);
  assert.equal(pb.trs().length, 100);
  await settled(pb, /Lignes 1–100 sur 250/);
  assert.equal(pbtn(pb, 'Première page').disabled, true);
  assert.equal(pbtn(pb, 'Page précédente').disabled, true);
  assert.equal(pbtn(pb, 'Page suivante').disabled, false);
  assert.deepEqual(idsN(pb).slice(0, 3), [1, 2, 3]);
  ok('première page : 100 lignes, « Lignes 1–100 sur 250 » (total compté en arrière-plan), précédent désactivé');

  await go(pb, () => pbtn(pb, 'Page suivante').click());
  assert.equal(pb.trs().length, 100);
  assert.deepEqual([idsN(pb)[0], idsN(pb)[99]], [101, 200]);
  assert.equal(nums(pb)[0], 101, 'numérotation continue d\'une page à l\'autre');
  assert.ok(/Lignes 101–200 sur 250/.test(pos(pb)));
  await go(pb, () => pbtn(pb, 'Page suivante').click());
  assert.equal(pb.trs().length, 50);
  assert.equal(pbtn(pb, 'Page suivante').disabled, true, 'dernière page');
  assert.ok(/Lignes 201–250 sur 250/.test(pos(pb)));
  await go(pb, () => pbtn(pb, 'Page précédente').click());
  assert.equal(idsN(pb)[0], 101);
  await go(pb, () => pbtn(pb, 'Première page').click());
  assert.equal(idsN(pb)[0], 1);
  ok('suivant / précédent / première page, dernière page détectée (page+1), numérotation continue');

  // taille de page
  const sel = pb.d.querySelector('.bar select');
  sel.value = '25'; sel.dispatchEvent(new pb.w.Event('change', { bubbles: true }));
  await until(() => pb.trs().length === 25, 'taille 25');
  await settled(pb, /Lignes 1–25 sur 250/);
  assert.equal(pb.d.querySelector('.bar select').value, '25');
  ok('changement de taille de page : retour page 1, 25 lignes');

  // tri : pas de doublon ni d'oubli d'une page à l'autre (departage par la clé primaire)
  const th = (pp, i) => pp.d.querySelectorAll('thead th')[i];
  await go(pb, () => th(pb, 3).click());
  assert.ok(th(pb, 3).textContent.includes('▲'));
  assert.ok(idsN(pb).every((i) => i % 3 === 0), 'page 1 triée par grp ASC : que des grp = 0');
  await go(pb, () => th(pb, 3).click());
  assert.ok(th(pb, 3).textContent.includes('▼'));
  const seen = [];
  for (let k = 0; k < 20; k++) {
    seen.push(...idsN(pb));
    if (pbtn(pb, 'Page suivante').disabled) { break; }
    await go(pb, () => pbtn(pb, 'Page suivante').click());
  }
  assert.equal(seen.length, 250);
  assert.equal(new Set(seen).size, 250, 'aucune ligne en double ni manquante entre les pages');
  await go(pb, () => th(pb, 3).click());
  assert.ok(!th(pb, 3).textContent.match(/[▲▼]/), '3e clic : tri retiré');
  assert.deepEqual(idsN(pb).slice(0, 3), [1, 2, 3], 'retour à l\'ordre de la clé primaire');
  ok('tri serveur ASC → DESC → aucun ; 250 lignes lues en 10 pages sans doublon ni trou (clé primaire en départage)');

  // filtre : jokers LIKE neutralisés, insensible à la casse, sur toute la table
  const f2 = pb.d.querySelector('input[type=search]');
  pb.type(f2, 'a%b');
  await until(() => pb.ids().join() === '7', 'filtre %'); await settled(pb, /sur 1\b/);
  pb.type(f2, 'a_b');
  await until(() => pb.ids().join() === '8', 'filtre _'); await settled(pb, /sur 1\b/);
  pb.type(f2, 'LIGNE 25');
  await until(() => pb.ids().join() === '25,250', 'filtre casse'); await settled(pb, /sur 2\b/);
  pb.type(f2, "x' OR 1=1 --");
  await until(() => pb.trs().length === 0, 'filtre hostile'); await settled(pb, /Aucune ligne/);
  assert.equal(await count('pag'), 250);
  ok('filtre : % et _ littéraux, insensible à la casse, « LIGNE 25 » → 25 et 250, total 2 ; injection inoffensive');

  // filtre + page suivante : l'offset repart de 0 au changement de filtre, le filtre est conservé en changeant de page
  pb.type(f2, 'Ligne 1');
  await until(() => pb.trs().length === 25 && /sur 111\b/.test(pos(pb)), 'filtre Ligne 1 (111 lignes)');
  await go(pb, () => pbtn(pb, 'Page suivante').click());
  assert.ok(idsN(pb).every((i) => String(i).startsWith('1')), 'le filtre reste actif sur la page suivante');
  assert.ok(/Lignes 26–50 sur 111/.test(pos(pb)), pos(pb));
  pb.type(f2, '');
  await until(() => pb.trs().length === 25 && /Lignes 1–25 sur 250/.test(pos(pb)), 'filtre effacé');
  ok('filtre conservé en changeant de page ; effacé → retour page 1 et total 250');

  // écriture sur une page autre que la première : bonne ligne, total ajusté
  await go(pb, () => pbtn(pb, 'Page suivante').click());          // 26–50
  const victim = idsN(pb)[2];                                        // 28
  tr = (pb.pencil(pb.rowById(victim)).click(), pb.editing());
  pb.type(pb.input(tr, 'txt'), 'modifiée page 2');
  pb.save();
  await waitOp(pb, 'ok', 'update page 2');
  assert.equal((await row('pag', `${q('id')} = ${victim}`))[2], 'modifiée page 2');
  assert.equal((await row('pag', `${q('id')} = 3`))[2], 'Ligne 3', 'les autres lignes sont intactes');
  const cnt2 = await count('pag');
  pb.check(pb.rowById(victim + 1));
  global.__nextChoice = 'Supprimer';
  pb.delBtn().click();
  await waitOp(pb, 'ok', 'delete page 2');
  assert.equal(await count('pag'), cnt2 - 1);
  assert.equal(await row('pag', `${q('id')} = ${victim + 1}`), undefined);
  await settled(pb, /sur 249\b/);
  assert.equal(pb.trs().length, 24);
  addBtnOf(pb).click();
  pb.type(ta(pb, 'id'), '9000'); pb.type(ta(pb, 'grp'), '0'); pb.type(ta(pb, 'txt'), 'nouvelle');
  okBtn(pb).click();
  await waitOp(pb, 'ok', 'insert page 2');
  await settled(pb, /sur 250\b/);
  assert.equal(await count('pag'), cnt2);
  ok('modification / suppression / insertion sur la page 2 : bonne ligne touchée, total 250 → 249 → 250 sans recompter');

  // jeton périmé : le message d'une page précédente est ignoré
  const oldTok = nPages();
  const tokBefore = global.__replies.filter((m) => m.type === 'page').slice(-1)[0].token;
  await go(pb, () => pbtn(pb, 'Page précédente').click());
  const c3 = await count('pag');
  global.__vsPanels[0].handlers.forEach((h) => h({ type: 'deleteRows', token: tokBefore, rowIndexes: [0, 1, 2] }));
  await tick(80);
  assert.equal(await count('pag'), c3);
  ok('suppression demandée depuis une page déjà quittée : ignorée');

  // messages forgés : tri / taille / filtre invalides → pageError, rien ne change
  const curTok = global.__replies.filter((m) => m.type === 'page').slice(-1)[0].token;
  const pe = async (m) => { const n = global.__replies.filter((x) => x.type === 'pageError').length; global.__vsPanels[0].handlers.forEach((h) => h({ type: 'browse', token: curTok, ...m })); await until(() => global.__replies.filter((x) => x.type === 'pageError').length > n, 'pageError'); return global.__replies.filter((x) => x.type === 'pageError').slice(-1)[0].message; };
  assert.match(await pe({ sort: { col: 99, dir: 'asc' } }), /Tri invalide/);
  assert.match(await pe({ sort: { col: 0, dir: 'DROP' } }), /Tri invalide/);
  assert.match(await pe({ pageSize: -5 }), /Taille de page invalide/);
  assert.match(await pe({ pageSize: '10; DROP' }), /Taille de page invalide/);
  assert.match(await pe({ filter: { a: 1 } }), /Filtre invalide/);
  assert.equal(await count('pag'), c3);
  ok('requêtes de navigation forgées refusées (tri, taille, filtre)');

  // actualiser : relit la base (ligne ajoutée par un tiers)
  await db(`INSERT INTO ${T('pag')} VALUES (9001, 1, 'tiers')`);
  await go(pb, () => pbtn(pb, 'Actualiser').click());
  await settled(pb, /sur 251\b/);
  ok('actualiser : relit la page et recompte (ligne ajoutée par un tiers → 251)');

  // table sans clé primaire : pagination possible, lecture seule, ordre libre
  const sp = await preview('sanspk', 1);
  assert.equal(sp.trs().length, 1);
  assert.equal(pbtn(sp, 'Page suivante').disabled, false);
  await go(sp, () => pbtn(sp, 'Page suivante').click());
  assert.equal(sp.trs().length, 1);
  assert.equal(pbtn(sp, 'Page suivante').disabled, true);
  ok('table sans clé primaire : pagination OK (lecture seule)');

  // grosse page : taille plafonnée
  const bigp = await preview('pag', 99999);
  assert.ok(bigp.trs().length <= 1000);
  ok('taille de page demandée démesurée : plafonnée', `${bigp.trs().length} lignes`);

  console.log(`\n${passed} vérifications OK (${KIND})`);
  await driver.dispose();
})().catch(async (e) => { console.error('\n✗ ÉCHEC :', e.stack || e.message); try { await driver.dispose(); } catch {} process.exit(1); });

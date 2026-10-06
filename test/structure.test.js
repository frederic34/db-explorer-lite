// Page « Structure » : colonnes, index, contraintes, DDL, boutons.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { buildStructureHtml } = require('../.test-build/structurePanel.js');

function open(structure, extra = {}) {
  const sent = [];
  const html = buildStructureHtml({ title: 'shop.produits', connection: 'test', badges: ['PRODUCTION', 'lecture seule'], structure, ...extra }, 'n0nce');
  const dom = new JSDOM(html, { runScripts: 'dangerously', beforeParse(w) { w.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m) }); } });
  return { d: dom.window.document, w: dom.window, sent };
}

const S = {
  isView: false,
  columns: [
    { name: 'id', type: 'integer', nullable: false, primaryKey: true, default: "nextval('s')", extra: 'auto_increment' },
    { name: 'nom', type: 'text', nullable: false, primaryKey: false, default: null, comment: 'Nom <b>affiché</b>' },
    { name: 'note', type: 'text', nullable: true, primaryKey: false, default: "'x'" },
  ],
  indexes: [{ name: 'produits_pkey', columns: ['id'], unique: true, primary: true, method: 'btree' }],
  constraints: [{ name: 'produits_pkey', kind: 'PRIMARY KEY', definition: '(id)' }, { name: 'ck', kind: 'CHECK', definition: '((prix > 0))' }],
  ddl: 'CREATE TABLE "shop"."produits" (\n  "id" integer\n);',
};

test('sections, comptes, badges et DDL', () => {
  const p = open(S);
  assert.equal(p.d.querySelector('h1').textContent.startsWith('shop.produits'), true);
  assert.equal(p.d.querySelectorAll('.badge').length, 2);
  assert.deepEqual([...p.d.querySelectorAll('h2')].map((h) => h.textContent), ['Colonnes (3)', 'Index (1)', 'Contraintes (2)', 'DDL']);
  const rows = [...p.d.querySelectorAll('table')][0].querySelectorAll('tbody tr');
  assert.equal(rows.length, 3);
  assert.ok(rows[0].textContent.includes('auto_increment') && rows[0].textContent.includes('✓'));
  assert.equal(p.d.querySelector('pre').textContent, S.ddl);
  assert.ok(p.d.body.textContent.includes('Commentaire'));
});

test('boutons Copier et Ouvrir ; contenu hostile non interprété ; sans index ni contrainte', () => {
  const p = open(S);
  [...p.d.querySelectorAll('button')].find((b) => /Copier/.test(b.textContent)).click();
  [...p.d.querySelectorAll('button')].find((b) => /Ouvrir/.test(b.textContent)).click();
  assert.deepEqual(p.sent.map((m) => m.type), ['copy', 'openSql']);
  assert.equal(p.d.querySelectorAll('b').length, 0, 'commentaire HTML affiché comme texte');

  const evil = open({ ...S, indexes: [], constraints: [], ddl: '</script><img src=x onerror=alert(1)>' });
  assert.equal(evil.d.querySelectorAll('img').length, 0);
  assert.ok(/Aucun index/.test(evil.d.body.textContent) && /Aucune contrainte/.test(evil.d.body.textContent));
});

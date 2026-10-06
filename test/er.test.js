// Diagramme des relations : modèle, disposition, Mermaid, et page (jsdom).
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { buildEdges, layoutEr, toMermaid } = require('../.test-build/erLayout.js');
const { buildDiagramHtml, DIAGRAM_CONSTS } = require('../.test-build/diagramPanel.js');

const col = (name, type = 'int', extra = {}) => ({ name, type, pk: false, ...extra });
const table = (name, cols) => ({ name, columns: cols });
const child = (name, parent, extra = []) =>
  table(name, [col('id', 'int', { pk: true }), col(`${parent}_id`, 'int', { fk: { table: parent, column: 'id' } }), col('label', 'text'), ...extra]);

function shop() {
  return [
    table('clients', [col('id', 'int', { pk: true }), col('nom', 'text')]),
    child('commandes', 'clients'),
    child('lignes', 'commandes'),
    table('produits', [col('id', 'int', { pk: true }), col('nom', 'text'), col('prix', 'numeric')]),
    table('lignes_produits', [
      col('ligne_id', 'int', { pk: true, fk: { table: 'lignes', column: 'id' } }),
      col('produit_id', 'int', { pk: true, fk: { table: 'produits', column: 'id' } }),
      col('ext_id', 'int', { external: 'autre.pays' }),
    ]),
    table('orpheline', [col('id', 'int', { pk: true })]),
    table('autre_orpheline', [col('id', 'int', { pk: true })]),
  ];
}

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('liens : uniquement entre tables du diagramme', () => {
  const edges = buildEdges(shop());
  assert.deepEqual(edges.map((e) => `${e.from}.${e.fromCol}→${e.to}.${e.toCol}`).sort(),
    ['commandes.clients_id→clients.id', 'lignes.commandes_id→commandes.id', 'lignes_produits.ligne_id→lignes.id', 'lignes_produits.produit_id→produits.id']);
});

test('disposition : une table est à droite de celles qu\'elle référence, sans chevauchement', () => {
  const t = shop(), e = buildEdges(t);
  const l = layoutEr(t, e, { keysOnly: false });
  const at = Object.fromEntries(l.nodes.map((n) => [n.name, n]));
  assert.equal(l.nodes.length, t.length);
  for (const edge of e) {
    assert.ok(at[edge.from].x > at[edge.to].x, `${edge.from} à droite de ${edge.to}`);
  }
  for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) {
    assert.ok(!overlap(l.nodes[i], l.nodes[j]), `${l.nodes[i].name} / ${l.nodes[j].name}`);
  }
  // les tables sans lien sont rangées sous le diagramme
  const linkedBottom = Math.max(...['clients', 'commandes', 'lignes', 'produits', 'lignes_produits'].map((n) => at[n].y + at[n].h));
  assert.ok(at.orpheline.y > linkedBottom && at.autre_orpheline.y >= linkedBottom);
  assert.ok(l.width > 0 && l.height >= linkedBottom);
  assert.deepEqual(layoutEr(t, e, { keysOnly: false }), l, 'déterministe');
});

test('« clés seulement » : seules les colonnes de clé, plus petit', () => {
  const t = shop(), e = buildEdges(t);
  const full = layoutEr(t, e, { keysOnly: false }), keys = layoutEr(t, e, { keysOnly: true });
  const f = full.nodes.find((n) => n.name === 'produits'), k = keys.nodes.find((n) => n.name === 'produits');
  assert.deepEqual(k.rows.map((c) => c.name), ['id']);
  assert.equal(k.hidden, 2);
  assert.ok(k.h < f.h);
  const lp = keys.nodes.find((n) => n.name === 'lignes_produits');
  assert.deepEqual(lp.rows.map((c) => c.name), ['ligne_id', 'produit_id', 'ext_id'], 'clés externes conservées');
});

test('cycles, auto-référence, grosse couche et table très large', () => {
  const cyc = [table('a', [col('id', 'int', { pk: true }), col('b_id', 'int', { fk: { table: 'b', column: 'id' } })]),
               table('b', [col('id', 'int', { pk: true }), col('a_id', 'int', { fk: { table: 'a', column: 'id' } })]),
               table('arbre', [col('id', 'int', { pk: true }), col('parent_id', 'int', { fk: { table: 'arbre', column: 'id' } })])];
  const l = layoutEr(cyc, buildEdges(cyc), { keysOnly: false });
  assert.equal(l.nodes.length, 3);

  const star = [table('racine', [col('id', 'int', { pk: true })])];
  for (let i = 0; i < 80; i++) star.push(child(`enfant_${String(i).padStart(2, '0')}`, 'racine', [col('a'), col('b'), col('c')]));
  const ls = layoutEr(star, buildEdges(star), { keysOnly: false });
  assert.ok(ls.height <= 1700, `couche répartie en plusieurs colonnes (hauteur ${ls.height})`);
  for (let i = 0; i < ls.nodes.length; i++) for (let j = i + 1; j < ls.nodes.length; j++) assert.ok(!overlap(ls.nodes[i], ls.nodes[j]));

  const wide = [table('large', Array.from({ length: 60 }, (_, i) => col(`c${i}`)))];
  const lw = layoutEr(wide, [], { keysOnly: false });
  assert.equal(lw.nodes[0].rows.length, 25);
  assert.equal(lw.nodes[0].hidden, 35);
  assert.deepEqual(layoutEr([], [], { keysOnly: false }), { nodes: [], width: 0, height: 0 });
});

test('Mermaid erDiagram', () => {
  const t = shop();
  const m = toMermaid(t, buildEdges(t));
  assert.ok(m.startsWith('erDiagram\n'));
  assert.ok(m.includes('clients ||--o{ commandes : "clients_id"'));
  assert.ok(m.includes('    int id PK'));
  assert.ok(m.includes('    int ligne_id PK,FK'));
  assert.ok(m.includes('    int ext_id FK'));
  const odd = toMermaid([table('ma table', [col('numeric(10,2)'.slice(0, 0) + 'prix €', 'numeric(10,2)')])], []);
  assert.ok(odd.includes('"ma table" {') && odd.includes('numeric_10_2 prix_'), odd);
});

function page(over = {}) {
  const t = shop(), e = buildEdges(t);
  const payload = { title: 'shop', connection: 'test', badges: ['PRODUCTION'], tables: t, edges: e,
    layouts: { full: layoutEr(t, e, { keysOnly: false }), keys: layoutEr(t, e, { keysOnly: true }) },
    external: 1, skipped: 0, consts: DIAGRAM_CONSTS, ...over };
  const sent = [];
  const dom = new JSDOM(buildDiagramHtml(payload, 'n0nce'), { runScripts: 'dangerously', beforeParse(w) { w.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m) }); } });
  return { d: dom.window.document, w: dom.window, sent, payload };
}

test('page : tables, liens, en-tête, bascule « clés seulement »', () => {
  const p = page();
  assert.equal(p.d.querySelectorAll('.node').length, 7);
  assert.equal(p.d.querySelectorAll('path.edge').length, 4);
  assert.ok(/7 tables · 4 relations/.test(p.d.querySelector('.bar').textContent));
  assert.ok(p.d.querySelector('.badge.prod'));
  assert.ok(/1 clé\(s\) étrangère\(s\) mènent hors/.test(p.d.getElementById('hint').textContent));
  const before = p.d.querySelectorAll('text.col').length;
  const keys = p.d.getElementById('keysOnly');
  keys.checked = true; keys.dispatchEvent(new p.w.Event('change'));
  assert.ok(p.d.querySelectorAll('text.col').length < before);
  assert.equal(p.d.querySelectorAll('.node').length, 7);
  assert.ok([...p.d.querySelectorAll('text.more')].some((x) => /2 autres colonnes/.test(x.textContent)));
  assert.ok([...p.d.querySelectorAll('text.col')].some((x) => x.textContent.includes('↗')), 'clé externe marquée');
});

test('page : double-clic, recherche, survol, déplacement, export SVG', () => {
  const p = page();
  const node = (n) => p.d.querySelector(`.node[data-name="${n}"]`);
  node('produits').dispatchEvent(new p.w.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(JSON.stringify(p.sent.pop()), JSON.stringify({ type: 'open', table: 'produits' }));

  const s = p.d.querySelector('input[type=search]');
  s.value = 'LIGN'; s.dispatchEvent(new p.w.Event('input'));
  assert.deepEqual([...p.d.querySelectorAll('.node.match')].map((n) => n.getAttribute('data-name')).sort(), ['lignes', 'lignes_produits']);

  node('clients').dispatchEvent(new p.w.MouseEvent('mouseover', { bubbles: true }));
  assert.ok(p.d.querySelector('svg').classList.contains('dim'));
  assert.deepEqual([...p.d.querySelectorAll('.node.hl')].map((n) => n.getAttribute('data-name')).sort(), ['clients', 'commandes']);
  assert.equal(p.d.querySelectorAll('path.edge.hl').length, 1);
  node('clients').dispatchEvent(new p.w.MouseEvent('mouseout', { bubbles: true }));
  assert.ok(!p.d.querySelector('svg').classList.contains('dim'));

  // déplacement : la table et ses liens suivent
  const ev = (type, x, y) => { const e = new p.w.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }); return e; };
  const before = node('commandes').getAttribute('transform');
  const pathBefore = [...p.d.querySelectorAll('path.edge')].map((x) => x.getAttribute('d')).join('|');
  node('commandes').dispatchEvent(ev('pointerdown', 100, 100));
  p.d.querySelector('svg').dispatchEvent(ev('pointermove', 160, 140));
  p.d.querySelector('svg').dispatchEvent(ev('pointerup', 160, 140));
  assert.notEqual(node('commandes').getAttribute('transform'), before);
  assert.notEqual([...p.d.querySelectorAll('path.edge')].map((x) => x.getAttribute('d')).join('|'), pathBefore);

  // « Réorganiser » remet la disposition automatique
  [...p.d.querySelectorAll('.bar button')].find((b) => /Réorganiser/.test(b.textContent)).click();
  assert.equal(node('commandes').getAttribute('transform'), before);

  [...p.d.querySelectorAll('.bar button')].find((b) => /SVG/.test(b.textContent)).click();
  const msg = p.sent.pop();
  assert.equal(msg.type, 'saveSvg');
  assert.ok(msg.svg.startsWith('<?xml') && msg.svg.includes('viewBox') && msg.svg.includes('<rect'));
  assert.ok(!msg.svg.includes('var(--vscode'), 'couleurs figées dans l\'export');
  assert.ok(msg.svg.includes('commandes'));

  [...p.d.querySelectorAll('.bar button')].find((b) => /Mermaid/.test(b.textContent)).click();
  assert.equal(p.sent.pop().type, 'copyMermaid');
});

test('page : schéma vide, noms hostiles échappés', () => {
  const e = page({ tables: [], edges: [], layouts: { full: { nodes: [], width: 0, height: 0 }, keys: { nodes: [], width: 0, height: 0 } } });
  assert.ok(/Aucune table/.test(e.d.getElementById('stage').textContent));
  const evil = [table('</script><img src=x onerror=alert(1)>', [col('"><b>x</b>')])];
  const l = layoutEr(evil, [], { keysOnly: false });
  const p = page({ tables: evil, edges: [], layouts: { full: l, keys: l } });
  assert.equal(p.d.querySelectorAll('img').length, 0);
  assert.equal(p.d.querySelectorAll('b').length, 0);
  assert.ok(p.d.querySelector('.node text.title').textContent.includes('</script>'));
});

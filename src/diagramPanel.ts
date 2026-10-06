import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { CHAR_W, ErEdge, ErLayout, ErTable, HEAD_H, PAD, ROW_H } from './erLayout';

export interface DiagramPayload {
  title: string;
  connection: string;
  badges?: string[];
  tables: ErTable[];
  edges: ErEdge[];
  layouts: { full: ErLayout; keys: ErLayout };
  /** Clés étrangères vers des tables absentes du diagramme (autre base ou schéma). */
  external: number;
  /** Tables laissées de côté (au-delà de la limite). */
  skipped: number;
  consts: { headH: number; rowH: number; pad: number; charW: number };
}

const THEME = `
  .box { fill: var(--vscode-editor-background); stroke: var(--vscode-panel-border); stroke-width: 1.2; }
  .head { fill: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); stroke: var(--vscode-panel-border); stroke-width: 1.2; }
  .title { fill: var(--vscode-foreground); font-weight: 600; }
  .col { fill: var(--vscode-foreground); }
  .typ { fill: var(--vscode-descriptionForeground); }
  .key { fill: var(--vscode-charts-yellow, #d7ba7d); font-weight: 700; font-size: 9px; }
  .fkm { fill: var(--vscode-charts-blue, #569cd6); font-weight: 700; font-size: 9px; }
  .more { fill: var(--vscode-descriptionForeground); font-style: italic; }
  .edge { fill: none; stroke: var(--vscode-descriptionForeground); stroke-width: 1.4; opacity: 0.75; }
  .marker { fill: var(--vscode-descriptionForeground); stroke: none; }
  svg.dim .node { opacity: 0.28; } svg.dim .edge { opacity: 0.12; }
  svg.dim .node.hl { opacity: 1; } svg.dim .edge.hl { opacity: 1; stroke: var(--vscode-focusBorder); stroke-width: 2.2; }
  .node.match .box { stroke: var(--vscode-focusBorder); stroke-width: 2.4; }
  .node { cursor: grab; } .node:active { cursor: grabbing; }
`;

const STATIC = `
  .box { fill: #ffffff; stroke: #9aa0a6; stroke-width: 1.2; }
  .head { fill: #eef1f5; stroke: #9aa0a6; stroke-width: 1.2; }
  .title { fill: #1f2328; font-weight: 600; }
  .col { fill: #1f2328; } .typ { fill: #6b7280; }
  .key { fill: #b8860b; font-weight: 700; font-size: 9px; } .fkm { fill: #2563eb; font-weight: 700; font-size: 9px; }
  .more { fill: #6b7280; font-style: italic; }
  .edge { fill: none; stroke: #6b7280; stroke-width: 1.4; }
  .marker { fill: #6b7280; stroke: none; }
`;

const CSS = `
  html, body { height: 100%; }
  #root { display: contents; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); margin: 0; display: flex; flex-direction: column; overflow: hidden; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 6px 12px; flex-wrap: wrap;
         border-bottom: 1px solid var(--vscode-panel-border); }
  .bar .muted { color: var(--vscode-descriptionForeground); }
  .badge { padding: 0 7px; border-radius: 3px; font-size: 0.8em; font-weight: 600; border: 1px solid var(--vscode-descriptionForeground); color: var(--vscode-descriptionForeground); }
  .badge.prod { background: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
  .spacer { flex: 1; }
  input[type=search] { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
                       border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; width: 170px; }
  label.chk { display: flex; align-items: center; gap: 4px; cursor: pointer; }
  button { font: inherit; border: none; border-radius: 2px; cursor: pointer; padding: 4px 10px;
           background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  #hint { padding: 3px 12px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  #stage { flex: 1; min-height: 0; position: relative; }
  svg { width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
  svg text { font-family: var(--vscode-editor-font-family); font-size: 12px; user-select: none; }
  #empty { padding: 30px; }
`;

const SCRIPT = String.raw`
(function () {
  var vscode = acquireVsCodeApi();
  var data = JSON.parse(document.getElementById('data').textContent);
  var C = data.consts;
  var NS = 'http://www.w3.org/2000/svg';
  var root = document.getElementById('root');
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text !== undefined) { e.textContent = text; } return e; }
  function sv(tag, attrs) { var e = document.createElementNS(NS, tag); Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); }); return e; }

  var bar = el('div', 'bar');
  bar.appendChild(el('strong', '', data.title));
  (data.badges || []).forEach(function (b) { bar.appendChild(el('span', 'badge' + (b === 'PRODUCTION' ? ' prod' : ''), b)); });
  bar.appendChild(el('span', 'muted', data.connection + ' · ' + data.tables.length + ' tables · ' + data.edges.length + ' relations'));
  bar.appendChild(el('span', 'spacer'));
  var search = el('input'); search.type = 'search'; search.placeholder = 'Chercher une table…'; search.setAttribute('aria-label', 'Chercher une table');
  var keysLabel = el('label', 'chk'); var keys = el('input'); keys.type = 'checkbox'; keys.id = 'keysOnly';
  keysLabel.appendChild(keys); keysLabel.appendChild(document.createTextNode(' Clés seulement'));
  var bIn = el('button', '', '+'); bIn.title = 'Zoom avant'; bIn.setAttribute('aria-label', 'Zoom avant');
  var bOut = el('button', '', '−'); bOut.title = 'Zoom arrière'; bOut.setAttribute('aria-label', 'Zoom arrière');
  var bFit = el('button', '', 'Ajuster'); bFit.title = 'Tout afficher';
  var bReset = el('button', '', 'Réorganiser'); bReset.title = 'Revenir à la disposition automatique';
  var bMer = el('button', '', 'Copier (Mermaid)'); bMer.title = 'Copier le schéma au format Mermaid erDiagram';
  var bSvg = el('button', '', 'Exporter en SVG');
  [search, keysLabel, bOut, bIn, bFit, bReset, bMer, bSvg].forEach(function (x) { bar.appendChild(x); });
  root.appendChild(bar);
  var hintText = 'Glisser une table pour la déplacer, le fond pour se déplacer, la molette pour zoomer, double-clic sur une table pour afficher ses données.';
  if (data.external > 0) { hintText += ' ' + data.external + ' clé(s) étrangère(s) mènent hors du diagramme (marquées ↗).'; }
  if (data.skipped > 0) { hintText += ' ' + data.skipped + ' table(s) non affichées (limite atteinte).'; }
  root.appendChild(el('div', '', '')).id = 'hint';
  document.getElementById('hint').textContent = hintText;

  var stage = el('div'); stage.id = 'stage'; root.appendChild(stage);
  if (data.tables.length === 0) { stage.appendChild(el('div', '', 'Aucune table dans ce schéma.')).id = 'empty'; return; }

  var svg = sv('svg', { role: 'img', 'aria-label': 'Diagramme des relations' });
  var defs = sv('defs');
  var style = document.createElementNS(NS, 'style'); style.id = 'themeStyle'; // rempli seulement à l'export (la CSP interdit les styles ajoutés par script)
  defs.appendChild(style);
  var arrow = sv('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '9', markerHeight: '9', orient: 'auto-start-reverse' });
  arrow.appendChild(sv('path', { d: 'M0,0 L10,5 L0,10 z', 'class': 'marker' }));
  var dot = sv('marker', { id: 'dot', viewBox: '0 0 10 10', refX: '5', refY: '5', markerWidth: '6', markerHeight: '6' });
  dot.appendChild(sv('circle', { cx: '5', cy: '5', r: '4', 'class': 'marker' }));
  defs.appendChild(arrow); defs.appendChild(dot);
  svg.appendChild(defs);
  var scene = sv('g', { id: 'scene' });
  var edgeLayer = sv('g'); var nodeLayer = sv('g');
  scene.appendChild(edgeLayer); scene.appendChild(nodeLayer);
  svg.appendChild(scene);
  stage.appendChild(svg);

  var byName = {};
  data.tables.forEach(function (t) { byName[t.name] = t; });
  var pos = {};      // nom -> {x, y, w, h, rows, hidden}
  var view = { x: 20, y: 20, k: 1 };
  var nodeEls = {};
  var edgeEls = [];

  function loadLayout() {
    var l = keys.checked ? data.layouts.keys : data.layouts.full;
    pos = {};
    l.nodes.forEach(function (n) { pos[n.name] = { x: n.x, y: n.y, w: n.w, h: n.h, rows: n.rows, hidden: n.hidden }; });
  }

  function anchorY(name, col) {
    var p = pos[name];
    for (var i = 0; i < p.rows.length; i++) { if (p.rows[i].name === col) { return p.y + C.headH + C.rowH * (i + 0.5); } }
    return p.y + C.headH / 2;
  }

  function edgePath(e) {
    var a = pos[e.from], b = pos[e.to];
    var ay = anchorY(e.from, e.fromCol), by = anchorY(e.to, e.toCol);
    if (e.from === e.to) {
      var rx = a.x + a.w;
      return 'M' + rx + ',' + ay + ' C' + (rx + 50) + ',' + ay + ' ' + (rx + 50) + ',' + (by + 24) + ' ' + rx + ',' + (by + 24);
    }
    var sx, ex, sd, ed;
    if (b.x + b.w + 8 <= a.x) { sx = a.x; sd = -1; ex = b.x + b.w; ed = 1; }
    else if (a.x + a.w + 8 <= b.x) { sx = a.x + a.w; sd = 1; ex = b.x; ed = -1; }
    else { sx = a.x + a.w; sd = 1; ex = b.x + b.w; ed = 1; }
    var dd = Math.max(48, Math.abs(ex - sx) / 2);
    return 'M' + sx + ',' + ay + ' C' + (sx + sd * dd) + ',' + ay + ' ' + (ex + ed * dd) + ',' + by + ' ' + ex + ',' + by;
  }

  function drawEdges() {
    edgeLayer.replaceChildren();
    edgeEls = data.edges.map(function (e) {
      var p = sv('path', { 'class': 'edge', d: edgePath(e), 'marker-end': 'url(#arrow)', 'marker-start': 'url(#dot)' });
      var t = sv('title'); t.textContent = e.from + '.' + e.fromCol + ' → ' + e.to + '.' + e.toCol; p.appendChild(t);
      edgeLayer.appendChild(p);
      return { e: e, p: p };
    });
  }

  function drawNode(name) {
    var t = byName[name], p = pos[name];
    var g = sv('g', { 'class': 'node', 'data-name': name, transform: 'translate(' + p.x + ',' + p.y + ')' });
    g.appendChild(sv('rect', { 'class': 'box', width: p.w, height: p.h, rx: 5 }));
    g.appendChild(sv('rect', { 'class': 'head', width: p.w, height: C.headH, rx: 5 }));
    var title = sv('text', { 'class': 'title', x: C.pad, y: C.headH / 2 + 4 }); title.textContent = name; g.appendChild(title);
    p.rows.forEach(function (c, i) {
      var y = C.headH + C.rowH * i + 13;
      var mark = c.pk ? 'PK' : (c.fk || c.external ? 'FK' : '');
      if (mark) { var m = sv('text', { 'class': c.pk ? 'key' : 'fkm', x: C.pad, y: y }); m.textContent = mark; g.appendChild(m); }
      var n = sv('text', { 'class': 'col', x: C.pad + 20, y: y }); n.textContent = c.name + (c.external ? ' ↗' : ''); g.appendChild(n);
      var ty = sv('text', { 'class': 'typ', x: p.w - C.pad, y: y, 'text-anchor': 'end' }); ty.textContent = c.type; g.appendChild(ty);
      if (c.external) { var tt = sv('title'); tt.textContent = c.name + ' → ' + c.external; n.appendChild(tt); }
    });
    if (p.hidden > 0) {
      var mo = sv('text', { 'class': 'more', x: C.pad + 20, y: C.headH + C.rowH * p.rows.length + 13 });
      mo.textContent = '… ' + p.hidden + ' autre' + (p.hidden > 1 ? 's' : '') + ' colonne' + (p.hidden > 1 ? 's' : ''); g.appendChild(mo);
    }
    var tip = sv('title'); tip.textContent = name + ' — ' + t.columns.length + ' colonnes'; g.appendChild(tip);
    nodeLayer.appendChild(g);
    nodeEls[name] = g;
    return g;
  }

  function draw() {
    nodeLayer.replaceChildren(); nodeEls = {};
    Object.keys(pos).forEach(drawNode);
    drawEdges();
    applySearch();
  }

  function applyTransform() { scene.setAttribute('transform', 'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')'); }
  function bounds() {
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    Object.keys(pos).forEach(function (n) { var p = pos[n]; x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h); });
    return { x0: x0, y0: y0, x1: x1 + 60, y1: y1 + 30 };
  }
  function fit() {
    var b = bounds(), W = stage.clientWidth || 1000, H = stage.clientHeight || 600;
    var k = Math.min(1.2, (W - 40) / (b.x1 - b.x0), (H - 40) / (b.y1 - b.y0));
    view.k = Math.max(0.05, k);
    view.x = 20 - b.x0 * view.k; view.y = 20 - b.y0 * view.k;
    applyTransform();
  }
  function zoomAt(f, cx, cy) {
    var k = Math.max(0.05, Math.min(3, view.k * f));
    view.x = cx - (cx - view.x) * (k / view.k); view.y = cy - (cy - view.y) * (k / view.k); view.k = k;
    applyTransform();
  }

  // --- interactions ---------------------------------------------------------------------
  var drag = null;
  svg.addEventListener('pointerdown', function (ev) {
    var g = ev.target.closest ? ev.target.closest('.node') : null;
    drag = g ? { node: g.getAttribute('data-name'), sx: ev.clientX, sy: ev.clientY, ox: pos[g.getAttribute('data-name')].x, oy: pos[g.getAttribute('data-name')].y }
             : { pan: true, sx: ev.clientX, sy: ev.clientY, ox: view.x, oy: view.y };
    if (svg.setPointerCapture && ev.pointerId !== undefined) { try { svg.setPointerCapture(ev.pointerId); } catch (e) {} }
  });
  svg.addEventListener('pointermove', function (ev) {
    if (!drag) { return; }
    var dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
    if (drag.pan) { view.x = drag.ox + dx; view.y = drag.oy + dy; applyTransform(); return; }
    var p = pos[drag.node];
    p.x = drag.ox + dx / view.k; p.y = drag.oy + dy / view.k;
    nodeEls[drag.node].setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
    edgeEls.forEach(function (x) { if (x.e.from === drag.node || x.e.to === drag.node) { x.p.setAttribute('d', edgePath(x.e)); } });
  });
  function endDrag() { drag = null; }
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var r = svg.getBoundingClientRect();
    zoomAt(ev.deltaY < 0 ? 1.15 : 1 / 1.15, ev.clientX - r.left, ev.clientY - r.top);
  }, { passive: false });
  svg.addEventListener('dblclick', function (ev) {
    var g = ev.target.closest ? ev.target.closest('.node') : null;
    if (g) { vscode.postMessage({ type: 'open', table: g.getAttribute('data-name') }); }
  });
  svg.addEventListener('mouseover', function (ev) {
    var g = ev.target.closest ? ev.target.closest('.node') : null;
    if (!g) { return; }
    var name = g.getAttribute('data-name'), rel = {};
    rel[name] = true;
    edgeEls.forEach(function (x) {
      var on = x.e.from === name || x.e.to === name;
      x.p.classList.toggle('hl', on);
      if (on) { rel[x.e.from] = true; rel[x.e.to] = true; }
    });
    Object.keys(nodeEls).forEach(function (n) { nodeEls[n].classList.toggle('hl', !!rel[n]); });
    svg.classList.add('dim');
  });
  svg.addEventListener('mouseout', function (ev) {
    var g = ev.target.closest ? ev.target.closest('.node') : null;
    if (!g) { return; }
    svg.classList.remove('dim');
    edgeEls.forEach(function (x) { x.p.classList.remove('hl'); });
    Object.keys(nodeEls).forEach(function (n) { nodeEls[n].classList.remove('hl'); });
  });

  function applySearch() {
    var q = search.value.trim().toLowerCase();
    Object.keys(nodeEls).forEach(function (n) { nodeEls[n].classList.toggle('match', !!q && n.toLowerCase().indexOf(q) !== -1); });
  }
  search.addEventListener('input', applySearch);
  search.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') { return; }
    var q = search.value.trim().toLowerCase();
    var name = Object.keys(pos).filter(function (n) { return q && n.toLowerCase().indexOf(q) !== -1; })[0];
    if (!name) { return; }
    var p = pos[name], W = stage.clientWidth || 1000, H = stage.clientHeight || 600;
    view.k = Math.max(view.k, 0.8);
    view.x = W / 2 - (p.x + p.w / 2) * view.k; view.y = H / 2 - (p.y + p.h / 2) * view.k;
    applyTransform();
  });
  keys.addEventListener('change', function () { loadLayout(); draw(); fit(); });
  bIn.addEventListener('click', function () { zoomAt(1.25, (stage.clientWidth || 1000) / 2, (stage.clientHeight || 600) / 2); });
  bOut.addEventListener('click', function () { zoomAt(1 / 1.25, (stage.clientWidth || 1000) / 2, (stage.clientHeight || 600) / 2); });
  bFit.addEventListener('click', fit);
  bReset.addEventListener('click', function () { loadLayout(); draw(); fit(); });
  bMer.addEventListener('click', function () { vscode.postMessage({ type: 'copyMermaid' }); });
  bSvg.addEventListener('click', function () {
    var b = bounds();
    var out = svg.cloneNode(true);
    out.removeAttribute('class'); out.removeAttribute('style');
    out.setAttribute('xmlns', NS);
    out.setAttribute('viewBox', (b.x0 - 20) + ' ' + (b.y0 - 20) + ' ' + (b.x1 - b.x0 + 40) + ' ' + (b.y1 - b.y0 + 40));
    out.setAttribute('width', Math.round(b.x1 - b.x0 + 40)); out.setAttribute('height', Math.round(b.y1 - b.y0 + 40));
    out.querySelector('#scene').removeAttribute('transform');
    out.querySelector('#themeStyle').textContent = data.staticTheme + ' text { font-family: monospace; font-size: 12px; }';
    var bg = sv('rect', { x: b.x0 - 20, y: b.y0 - 20, width: b.x1 - b.x0 + 40, height: b.y1 - b.y0 + 40, fill: '#ffffff' });
    out.insertBefore(bg, out.querySelector('#scene'));
    vscode.postMessage({ type: 'saveSvg', svg: '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(out) });
  });

  loadLayout(); draw(); fit();
  window.__er = { pos: function () { return pos; }, fit: fit };
})();
`;

export function buildDiagramHtml(payload: DiagramPayload, nonce: string): string {
  const data = JSON.stringify({ ...payload, staticTheme: STATIC }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Diagramme</title>
<style nonce="${nonce}">${CSS}${THEME}</style>
</head>
<body>
<div id="root"></div>
<script id="data" type="application/json" nonce="${nonce}">${data}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

export const DIAGRAM_CONSTS = { headH: HEAD_H, rowH: ROW_H, pad: PAD, charW: CHAR_W };

/** Un panneau par schéma ; rouvrir le même schéma remplace le diagramme. */
export class DiagramPanels {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly state = new Map<string, { payload: DiagramPayload; mermaid: string; onOpen: (table: string) => void }>();

  show(key: string, payload: DiagramPayload, mermaid: string, onOpen: (table: string) => void): void {
    let panel = this.panels.get(key);
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        'dbExplorer.diagram',
        `Diagramme · ${payload.title}`,
        { viewColumn: vscode.ViewColumn.Active },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.panels.set(key, panel);
      panel.onDidDispose(() => {
        this.panels.delete(key);
        this.state.delete(key);
      });
      panel.webview.onDidReceiveMessage(async (msg: { type?: string; table?: unknown; svg?: unknown }) => {
        const st = this.state.get(key);
        if (!st) {
          return;
        }
        if (msg?.type === 'open' && typeof msg.table === 'string' && st.payload.tables.some((t) => t.name === msg.table)) {
          st.onOpen(msg.table);
        } else if (msg?.type === 'copyMermaid') {
          await vscode.env.clipboard.writeText(st.mermaid);
          void vscode.window.showInformationMessage('Schéma Mermaid copié dans le presse-papiers.');
        } else if (msg?.type === 'saveSvg' && typeof msg.svg === 'string') {
          const uri = await vscode.window.showSaveDialog({ filters: { SVG: ['svg'] }, saveLabel: 'Exporter' });
          if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.svg, 'utf8'));
            void vscode.window.showInformationMessage(`Diagramme enregistré : ${uri.fsPath}`);
          }
        }
      });
    } else {
      panel.title = `Diagramme · ${payload.title}`;
      panel.reveal();
    }
    this.state.set(key, { payload, mermaid, onOpen });
    panel.webview.html = buildDiagramHtml(payload, randomBytes(16).toString('hex'));
  }
}

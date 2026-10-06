import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { buildCountQuery, buildPageQuery } from './browse';
import {
  buildDeletes,
  buildInsert,
  buildSelectRow,
  buildUpdate,
  EditPlan,
  planEditing,
} from './editing';
import { ColumnInfo, DbDriver, DbType, QueryResult } from './types';
import { errorMessage } from './util';

type Row = (string | null)[];

/** Table d'origine d'un aperçu : permet de modifier / supprimer des lignes via leur clé primaire. */
export interface EditSpec {
  dbType: DbType;
  container: string;
  table: string;
  tableColumns: ColumnInfo[];
  getDriver: () => Promise<DbDriver>;
  /** Connexion de production : confirmation avant toute écriture. */
  production?: boolean;
}

/** Aperçu paginé d'une table ou d'une vue. */
export interface TableSource extends EditSpec {
  connectionName: string;
  isView: boolean;
  /** Lignes par page au départ. */
  pageSize: number;
  /** Connexion en lecture seule : la grille n'est pas modifiable. */
  readOnly?: boolean;
  /** Mentions affichées en tête (PRODUCTION, LECTURE SEULE). */
  badges?: string[];
}

type SortState = { col: number; dir: 'asc' | 'desc' } | null;

/** État de navigation d'un aperçu : page, taille, tri et filtre sont gérés côté serveur. */
interface BrowseState {
  src: TableSource;
  offset: number;
  pageSize: number;
  sort: SortState;
  filter: string;
  hasNext: boolean;
  /** Total des lignes pour le filtre courant : undefined = calcul en cours, null = indisponible. */
  total?: number | null;
  /** Numéro de la dernière requête de page lancée / du dernier comptage lancé (pour ignorer les anciens). */
  loadSeq: number;
  countSeq: number;
}

interface BrowseInfo {
  offset: number;
  pageSize: number;
  hasNext: boolean;
  total?: number | null;
  sort: SortState;
  filter: string;
  isView: boolean;
}

const MAX_PAGE_SIZE = 1000;

interface Page {
  columns: string[];
  rows: Row[];
  hasNext: boolean;
  durationMs: number;
  sql: string;
}

interface EditInfo {
  table: string;
  pk: number[];
  editable: boolean[];
  insertable: boolean[];
  hasDefault: boolean[];
  nullable: boolean[];
}

interface Payload {
  kind: 'result' | 'error';
  token: string;
  connection: string;
  sql: string;
  columns: string[];
  rows: Row[];
  summary: string;
  error?: string;
  edit?: EditInfo;
  readOnlyReason?: string;
  browse?: BrowseInfo;
  badges?: string[];
}

interface State {
  columns: string[];
  /** Lignes d'origine ; null = supprimée (les indices restent stables pour la page). */
  rows: (Row | null)[];
  spec?: EditSpec;
  plan?: EditPlan;
  browse?: BrowseState;
}

const CSS = `
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); background: var(--vscode-editor-background);
         margin: 0; padding: 10px 14px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .badge { display: inline-block; margin-left: 8px; padding: 0 7px; border-radius: 3px; font-size: 0.8em; font-weight: 600;
           border: 1px solid var(--vscode-descriptionForeground); color: var(--vscode-descriptionForeground); }
  .badge.prod { background: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground);
                color: var(--vscode-editor-background); }
  .top { margin-bottom: 8px; }
  details.sql { margin-bottom: 8px; }
  details.sql summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
  pre { font-family: var(--vscode-editor-font-family); margin: 6px 0; white-space: pre-wrap;
        background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; }
  pre.error { color: var(--vscode-errorForeground); border-left: 3px solid var(--vscode-errorForeground); }
  .bar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
  .bar input[type=search] { flex: 0 1 260px; background: var(--vscode-input-background);
               color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
               padding: 3px 6px; }
  .spacer { flex: 1; }
  .pager { display: flex; align-items: center; gap: 4px; }
  .pager select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
                  border: 1px solid var(--vscode-dropdown-border, transparent); padding: 2px 4px; }
  .pager .pos { margin: 0 6px; }
  button { font: inherit; border: none; border-radius: 2px; cursor: pointer; padding: 4px 10px;
           background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.danger { background: transparent; color: var(--vscode-errorForeground);
                  border: 1px solid var(--vscode-errorForeground); }
  button.danger:hover:not(:disabled) { background: var(--vscode-inputValidation-errorBackground); }
  button:disabled { opacity: 0.45; cursor: default; }
  button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  button.icon { padding: 0 6px; line-height: 1.5; background: transparent; color: var(--vscode-foreground); }
  button.icon:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
  #opmsg { display: none; margin-bottom: 8px; padding: 6px 10px; border-left: 3px solid;
           background: var(--vscode-textBlockQuote-background); white-space: pre-wrap; word-break: break-word; }
  #opmsg.ok { display: block; border-color: var(--vscode-testing-iconPassed, #3fb950); }
  #opmsg.ko { display: block; border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
  #opmsg.busy { display: block; border-color: var(--vscode-focusBorder); }
  .wrap { overflow: auto; max-height: calc(100vh - 170px); border: 1px solid var(--vscode-panel-border); }
  table { border-collapse: collapse; width: max-content; min-width: 100%;
          font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  th, td { padding: 3px 10px; border-bottom: 1px solid var(--vscode-panel-border);
           border-right: 1px solid var(--vscode-panel-border); text-align: left;
           max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); z-index: 1; user-select: none; }
  th.sortable { cursor: pointer; }
  th.sortable:hover { background: var(--vscode-list-hoverBackground); }
  td.rownum, th.rownum { color: var(--vscode-descriptionForeground); text-align: right; }
  td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
  td.actions, th.actions { white-space: nowrap; padding: 2px 6px; width: 1%; }
  td.actions input { vertical-align: middle; margin: 0 4px 0 0; }
  td.pk { color: var(--vscode-descriptionForeground); }
  tbody tr:hover { background: var(--vscode-list-hoverBackground); }
  tbody tr.selected { background: var(--vscode-list-inactiveSelectionBackground); }
  tbody tr.editing { background: var(--vscode-list-inactiveSelectionBackground); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  td.editcell { overflow: visible; max-width: none; white-space: normal; vertical-align: top; }
  td.editcell .cellbox { display: flex; align-items: flex-start; gap: 6px; }
  td.editcell textarea {
    min-width: 140px; width: 100%; box-sizing: border-box; font: inherit; padding: 2px 4px;
    resize: vertical; overflow: hidden; display: block;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
  td.editcell .flags { display: flex; flex-direction: column; gap: 1px; }
  tr.inserting td.editcell textarea::placeholder { font-style: italic; }
  td.editcell label { display: flex; align-items: center; gap: 3px; white-space: nowrap;
                      color: var(--vscode-descriptionForeground); font-size: 0.85em; padding-top: 3px; }
  td.readonlycell { color: var(--vscode-descriptionForeground); }
`;

const SCRIPT = String.raw`
(function () {
  var vscode = acquireVsCodeApi();
  var data = JSON.parse(document.getElementById('data').textContent);
  var root = document.getElementById('root');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined) { e.textContent = text; }
    return e;
  }
  function plural(n, one, many) { return n + ' ' + (n > 1 ? many : one); }

  var top = el('div', 'top');
  top.appendChild(el('strong', '', data.connection));
  (data.badges || []).forEach(function (b) {
    top.appendChild(el('span', b === 'PRODUCTION' ? 'badge prod' : 'badge', b));
  });
  var summary = el('span', 'muted', ' · ' + data.summary);
  top.appendChild(summary);
  root.appendChild(top);

  var details = el('details', 'sql');
  details.appendChild(el('summary', '', 'Requête'));
  var sqlPre = el('pre', '', data.sql);
  details.appendChild(sqlPre);
  root.appendChild(details);

  if (data.kind === 'error') {
    root.appendChild(el('pre', 'error', data.error));
    return;
  }
  if (data.columns.length === 0) { return; }

  var edit = data.edit || null;
  var server = !!data.browse;
  var rows = data.rows.map(function (c, i) { return { i: i, c: c }; });
  var sortCol = -1;
  var asc = true;
  var term = '';
  var selected = {};
  var editing = null;
  var busy = false;
  var deletedCount = 0;
  var insertedCount = 0;
  var inserting = null;

  if (!edit && data.readOnlyReason) {
    root.appendChild(el('div', 'muted top', 'Lecture seule : ' + data.readOnlyReason + '.'));
  }

  var bar = el('div', 'bar');
  var filter = el('input');
  filter.type = 'search';
  filter.placeholder = server ? 'Filtrer (toute la table)…' : 'Filtrer les lignes…';
  if (server) { filter.value = data.browse.filter; }
  var info = el('span', 'muted');
  var spacer = el('span', 'spacer');
  var delBtn = null;
  var addBtn = null;
  if (edit) {
    delBtn = el('button', 'danger', 'Supprimer la sélection');
    addBtn = el('button', 'primary', 'Ajouter une ligne');
  }
  var exportBtn = el('button', '', 'Exporter en CSV');
  exportBtn.addEventListener('click', function () { vscode.postMessage({ type: 'exportCsv', token: data.token }); });
  bar.appendChild(filter);
  bar.appendChild(info);
  bar.appendChild(spacer);
  if (addBtn) { bar.appendChild(addBtn); }
  if (delBtn) { bar.appendChild(delBtn); }
  bar.appendChild(exportBtn);
  root.appendChild(bar);

  // --- Pagination côté serveur : la grille n'est qu'une fenêtre sur la table.
  var pagerBar = null, firstBtn, prevBtn, nextBtn, refreshBtn, sizeSel, pos;
  function ask(m) {
    m.type = 'browse';
    m.token = data.token;
    vscode.postMessage(m);
    pos.textContent = 'Chargement…';
  }
  if (server) {
    pagerBar = el('div', 'bar');
    var pg = el('div', 'pager');
    firstBtn = el('button', '', '⏮');
    firstBtn.title = 'Première page';
    prevBtn = el('button', '', '◀');
    prevBtn.title = 'Page précédente';
    nextBtn = el('button', '', '▶');
    nextBtn.title = 'Page suivante';
    refreshBtn = el('button', '', '⟳');
    refreshBtn.title = 'Actualiser';
    pos = el('span', 'muted pos');
    sizeSel = el('select');
    sizeSel.title = 'Lignes par page';
    sizeSel.setAttribute('aria-label', 'Lignes par page');
    [firstBtn, prevBtn, nextBtn, refreshBtn].forEach(function (b) { b.setAttribute('aria-label', b.title); });
    firstBtn.addEventListener('click', function () { ask({ page: 'first' }); });
    prevBtn.addEventListener('click', function () { ask({ page: 'prev' }); });
    nextBtn.addEventListener('click', function () { ask({ page: 'next' }); });
    refreshBtn.addEventListener('click', function () { ask({ refresh: true }); });
    sizeSel.addEventListener('change', function () { ask({ pageSize: Number(sizeSel.value) }); });
    pg.appendChild(firstBtn); pg.appendChild(prevBtn); pg.appendChild(pos);
    pg.appendChild(nextBtn); pg.appendChild(refreshBtn);
    pagerBar.appendChild(pg);
    var sz = el('span', 'muted', 'Lignes par page');
    pagerBar.appendChild(sz);
    pagerBar.appendChild(sizeSel);
    root.appendChild(pagerBar);
  }
  function updatePager() {
    if (!server) { return; }
    var b = data.browse;
    firstBtn.disabled = prevBtn.disabled = busy || b.offset === 0;
    nextBtn.disabled = busy || !b.hasNext;
    refreshBtn.disabled = busy;
    sizeSel.disabled = busy;
    var sizes = [25, 50, 100, 200, 500, 1000];
    if (sizes.indexOf(b.pageSize) === -1) { sizes.push(b.pageSize); sizes.sort(function (x, y) { return x - y; }); }
    sizeSel.replaceChildren();
    sizes.forEach(function (n) {
      var o = el('option', '', String(n));
      o.value = String(n);
      if (n === b.pageSize) { o.selected = true; }
      sizeSel.appendChild(o);
    });
    var totalTxt;
    if (typeof b.total === 'number') { totalTxt = ' sur ' + b.total; }
    else if (b.total === undefined) { totalTxt = ' sur …'; }
    else { totalTxt = b.hasNext ? ' (et plus)' : ''; }
    if (rows.length === 0) { pos.textContent = b.offset > 0 ? 'Page vide' : 'Aucune ligne'; }
    else { pos.textContent = 'Lignes ' + (b.offset + 1) + '–' + (b.offset + rows.length) + totalTxt; }
  }

  var opmsg = el('div');
  opmsg.id = 'opmsg';
  opmsg.setAttribute('role', 'status');
  opmsg.setAttribute('aria-live', 'polite');
  root.appendChild(opmsg);
  function showOp(kind, text) { opmsg.className = kind; opmsg.textContent = text; }
  function clearOp() { opmsg.className = ''; opmsg.textContent = ''; }

  function compare(a, b) {
    if (a === b) { return 0; }
    if (a === null) { return -1; }
    if (b === null) { return 1; }
    var na = Number(a), nb = Number(b);
    if (a.trim() !== '' && b.trim() !== '' && !isNaN(na) && !isNaN(nb)) { return na - nb; }
    return a.localeCompare(b, undefined, { numeric: true });
  }

  var wrap = el('div', 'wrap');
  var table = el('table');
  var thead = el('thead');
  var hr = el('tr');
  var selectAll = null;
  if (edit) {
    var thA = el('th', 'actions');
    selectAll = el('input');
    selectAll.type = 'checkbox';
    selectAll.title = 'Tout sélectionner (lignes affichées)';
    selectAll.setAttribute('aria-label', 'Tout sélectionner');
    thA.appendChild(selectAll);
    hr.appendChild(thA);
  }
  hr.appendChild(el('th', 'rownum', '#'));
  var ths = data.columns.map(function (name, i) {
    var th = el('th', 'sortable', name);
    th.title = 'Trier par cette colonne';
    th.addEventListener('click', function () {
      if (server) {
        // asc -> desc -> sans tri (ordre de la clé primaire), exécuté par le serveur.
        var cur = data.browse.sort;
        var next = !cur || cur.col !== i ? { col: i, dir: 'asc' } : (cur.dir === 'asc' ? { col: i, dir: 'desc' } : null);
        ask({ sort: next });
        return;
      }
      if (sortCol === i) { asc = !asc; } else { sortCol = i; asc = true; }
      rows.sort(function (a, b) { return compare(a.c[i], b.c[i]) * (asc ? 1 : -1); });
      updateHeaders();
      renderBody();
    });
    hr.appendChild(th);
    return th;
  });
  thead.appendChild(hr);
  table.appendChild(thead);
  var tbody = el('tbody');
  table.appendChild(tbody);
  wrap.appendChild(table);
  root.appendChild(wrap);

  function updateHeaders() {
    ths.forEach(function (th, i) {
      var key = edit && edit.pk.indexOf(i) !== -1 ? '🔑 ' : '';
      th.textContent = key + data.columns[i] + (sortCol === i ? (asc ? ' ▲' : ' ▼') : '');
    });
  }

  function visibleRows() {
    if (server || !term) { return rows; }
    return rows.filter(function (r) {
      return r.c.some(function (c) { return c !== null && c.toLowerCase().indexOf(term) !== -1; });
    });
  }
  function selectedCount() { return Object.keys(selected).length; }

  function updateBar() {
    var vis = visibleRows();
    updatePager();
    info.textContent = server ? '' : term ? vis.length + ' / ' + rows.length + ' lignes affichées' : '';
    if (edit) {
      addBtn.disabled = busy;
      var n = selectedCount();
      delBtn.textContent = n > 0 ? 'Supprimer la sélection (' + n + ')' : 'Supprimer la sélection';
      delBtn.disabled = busy || n === 0;
      var all = vis.length > 0 && vis.every(function (r) { return selected[r.i]; });
      selectAll.checked = all;
      selectAll.indeterminate = !all && vis.some(function (r) { return selected[r.i]; });
      selectAll.disabled = busy || vis.length === 0;
    }
    var extra = '';
    if (insertedCount > 0) { extra += ' · ' + plural(insertedCount, 'ligne ajoutée', 'lignes ajoutées'); }
    if (deletedCount > 0) { extra += ' · ' + plural(deletedCount, 'ligne supprimée', 'lignes supprimées'); }
    summary.textContent = ' · ' + data.summary + extra;
  }

  function cellText(td, c) {
    if (c === null) { td.className = 'null'; td.textContent = 'NULL'; return; }
    td.textContent = c;
    if (c.length > 60) { td.title = c.length > 1000 ? c.slice(0, 1000) + '…' : c; }
  }

  function setBusy(b) { busy = b; renderBody(); }

  function startEdit(i) {
    if (busy) { return; }
    var r = rows.filter(function (x) { return x.i === i; })[0];
    if (!r) { return; }
    inserting = null;
    editing = { i: i, vals: {}, nul: {} };
    data.columns.forEach(function (_n, j) {
      editing.vals[j] = r.c[j] === null ? '' : r.c[j];
      editing.nul[j] = r.c[j] === null;
    });
    clearOp();
    renderBody();
    var first = tbody.querySelector('tr.editing input[type=text], tr.editing textarea');
    if (first) { first.focus(); }
  }
  function cancelEdit() { editing = null; renderBody(); }

  function saveEdit() {
    if (!editing || busy) { return; }
    var r = rows.filter(function (x) { return x.i === editing.i; })[0];
    var changes = {};
    var count = 0;
    data.columns.forEach(function (_n, j) {
      if (!edit.editable[j]) { return; }
      var v = editing.nul[j] ? null : editing.vals[j];
      if (v !== r.c[j]) { changes[j] = v; count++; }
    });
    if (count === 0) { cancelEdit(); return; }
    showOp('busy', 'Enregistrement…');
    vscode.postMessage({ type: 'updateRow', token: data.token, rowIndex: editing.i, changes: changes });
    setBusy(true);
  }

  function renderEditRow(r, n) {
    var tr = el('tr', 'editing');
    var ta = el('td', 'actions');
    var ok = el('button', 'icon', '✓');
    ok.title = 'Enregistrer la ligne (Entrée)';
    ok.setAttribute('aria-label', 'Enregistrer la ligne');
    ok.disabled = busy;
    ok.addEventListener('click', saveEdit);
    var ko = el('button', 'icon', '✗');
    ko.title = 'Annuler (Échap)';
    ko.setAttribute('aria-label', 'Annuler la modification');
    ko.disabled = busy;
    ko.addEventListener('click', cancelEdit);
    ta.appendChild(ok);
    ta.appendChild(ko);
    tr.appendChild(ta);
    tr.appendChild(el('td', 'rownum', String(n)));
    data.columns.forEach(function (_name, j) {
      if (!edit.editable[j]) {
        var ro = el('td', edit.pk.indexOf(j) !== -1 ? 'pk' : 'readonlycell');
        cellText(ro, r.c[j]);
        ro.title = edit.pk.indexOf(j) !== -1 ? 'Clé primaire : non modifiable' : 'Colonne non modifiable';
        tr.appendChild(ro);
        return;
      }
      var td = el('td', 'editcell');
      var box = el('div', 'cellbox');
      var cur = editing.vals[j];
      // textarea partout : un <input> supprimerait les retours à la ligne (texte multiligne impossible).
      var input = el('textarea');
      input.rows = Math.min(6, Math.max(1, cur.split('\n').length));
      input.value = cur;
      var grow = function () {
        if (input.scrollHeight > 0) { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
      };
      input.spellcheck = false;
      input.setAttribute('aria-label', data.columns[j]);
      input.disabled = busy;
      var nulBox = null;
      if (edit.nullable[j]) {
        var lab = el('label');
        nulBox = el('input');
        nulBox.type = 'checkbox';
        nulBox.checked = editing.nul[j];
        nulBox.disabled = busy;
        lab.appendChild(nulBox);
        lab.appendChild(document.createTextNode('NULL'));
        nulBox.addEventListener('change', function () {
          editing.nul[j] = nulBox.checked;
          if (nulBox.checked) { input.value = ''; editing.vals[j] = ''; }
        });
        input.placeholder = 'NULL';
      }
      input.addEventListener('input', function () {
        editing.vals[j] = input.value;
        if (nulBox) { nulBox.checked = false; editing.nul[j] = false; }
        grow();
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
        else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
      });
      setTimeout(grow, 0);
      box.appendChild(input);
      if (nulBox) { box.appendChild(nulBox.parentNode); }
      td.appendChild(box);
      tr.appendChild(td);
    });
    return tr;
  }

  // --- Insertion : une ligne de saisie en tête de grille. Par colonne, trois états :
  //   default  = colonne omise (le serveur applique sa valeur par défaut / auto-incrément)
  //   null     = NULL explicite
  //   value    = valeur saisie
  //   required = colonne obligatoire pas encore renseignée (bloque l'envoi)
  function startInsert() {
    if (busy) { return; }
    editing = null;
    inserting = { cols: {} };
    data.columns.forEach(function (_n, j) {
      var mode = edit.hasDefault[j] ? 'default' : (edit.nullable[j] ? 'null' : 'required');
      inserting.cols[j] = { mode: mode, val: '' };
    });
    clearOp();
    renderBody();
    wrap.scrollTop = 0;
    var first = tbody.querySelector('tr.inserting textarea');
    if (first) { first.focus(); }
  }
  function cancelInsert() { inserting = null; renderBody(); }

  function saveInsert() {
    if (!inserting || busy) { return; }
    var values = {};
    for (var j = 0; j < data.columns.length; j++) {
      if (!edit.insertable[j]) { continue; }
      var c = inserting.cols[j];
      if (c.mode === 'required') {
        showOp('ko', 'La colonne « ' + data.columns[j] + ' » est obligatoire.');
        var field = tbody.querySelector('tr.inserting td:nth-child(' + (j + 3) + ') textarea');
        if (field) { field.focus(); }
        return;
      }
      if (c.mode === 'value') { values[j] = c.val; }
      else if (c.mode === 'null') { values[j] = null; }
    }
    showOp('busy', 'Insertion…');
    vscode.postMessage({ type: 'insertRow', token: data.token, values: values });
    setBusy(true);
  }

  function renderInsertRow() {
    var tr = el('tr', 'editing inserting');
    var ta = el('td', 'actions');
    var ok = el('button', 'icon', '✓');
    ok.title = 'Insérer la ligne (Entrée)';
    ok.setAttribute('aria-label', 'Insérer la ligne');
    ok.disabled = busy;
    ok.addEventListener('click', saveInsert);
    var ko = el('button', 'icon', '✗');
    ko.title = 'Annuler (Échap)';
    ko.setAttribute('aria-label', 'Annuler l’insertion');
    ko.disabled = busy;
    ko.addEventListener('click', cancelInsert);
    ta.appendChild(ok);
    ta.appendChild(ko);
    tr.appendChild(ta);
    tr.appendChild(el('td', 'rownum', '+'));
    data.columns.forEach(function (_name, j) {
      if (!edit.insertable[j]) {
        var ro = el('td', 'readonlycell', '—');
        ro.title = 'Valeur fournie par le serveur, ou type non pris en charge';
        tr.appendChild(ro);
        return;
      }
      var c = inserting.cols[j];
      var td = el('td', 'editcell');
      var box = el('div', 'cellbox');
      var input = el('textarea');
      input.rows = 1;
      input.value = c.val;
      input.spellcheck = false;
      input.disabled = busy;
      input.setAttribute('aria-label', data.columns[j]);
      input.placeholder = edit.hasDefault[j] ? '(défaut)' : (edit.nullable[j] ? 'NULL' : '(obligatoire)');
      var flags = el('div', 'flags');
      var defBox = null;
      var nulBox = null;
      function mk(text, checked) {
        var lab = el('label');
        var cb = el('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        cb.disabled = busy;
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(text));
        flags.appendChild(lab);
        return cb;
      }
      if (edit.hasDefault[j]) { defBox = mk('défaut', c.mode === 'default'); }
      if (edit.nullable[j]) { nulBox = mk('NULL', c.mode === 'null'); }
      function sync() {
        if (defBox) { defBox.checked = c.mode === 'default'; }
        if (nulBox) { nulBox.checked = c.mode === 'null'; }
      }
      var grow = function () {
        if (input.scrollHeight > 0) { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
      };
      input.addEventListener('input', function () { c.val = input.value; c.mode = 'value'; sync(); grow(); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); cancelInsert(); }
        else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveInsert(); }
      });
      if (defBox) {
        defBox.addEventListener('change', function () {
          if (defBox.checked) { c.mode = 'default'; c.val = ''; input.value = ''; }
          else { c.mode = 'value'; input.focus(); }
          sync();
        });
      }
      if (nulBox) {
        nulBox.addEventListener('change', function () {
          if (nulBox.checked) { c.mode = 'null'; c.val = ''; input.value = ''; }
          else { c.mode = edit.hasDefault[j] ? 'default' : 'value'; input.focus(); }
          sync();
        });
      }
      box.appendChild(input);
      if (flags.childNodes.length) { box.appendChild(flags); }
      td.appendChild(box);
      tr.appendChild(td);
    });
    return tr;
  }

  function renderRow(r, n) {
    if (editing && editing.i === r.i) { return renderEditRow(r, n); }
    var tr = document.createElement('tr');
    if (selected[r.i]) { tr.className = 'selected'; }
    if (edit) {
      var ta = el('td', 'actions');
      var cb = el('input', 'sel');
      cb.type = 'checkbox';
      cb.checked = !!selected[r.i];
      cb.disabled = busy;
      cb.setAttribute('aria-label', 'Sélectionner la ligne ' + n);
      cb.addEventListener('change', function () {
        if (cb.checked) { selected[r.i] = true; } else { delete selected[r.i]; }
        tr.className = cb.checked ? 'selected' : '';
        updateBar();
      });
      var pen = el('button', 'icon', '✎');
      pen.title = 'Modifier la ligne';
      pen.setAttribute('aria-label', 'Modifier la ligne ' + n);
      pen.disabled = busy;
      pen.addEventListener('click', function () { startEdit(r.i); });
      ta.appendChild(cb);
      ta.appendChild(pen);
      tr.appendChild(ta);
    }
    tr.appendChild(el('td', 'rownum', String(n)));
    for (var j = 0; j < r.c.length; j++) {
      var td = document.createElement('td');
      cellText(td, r.c[j]);
      if (edit && edit.pk.indexOf(j) !== -1 && r.c[j] !== null) { td.classList.add('pk'); }
      tr.appendChild(td);
    }
    return tr;
  }

  function renderBody() {
    var list = visibleRows();
    var frag = document.createDocumentFragment();
    if (inserting) { frag.appendChild(renderInsertRow()); }
    var base = server ? data.browse.offset : 0;
    for (var i = 0; i < list.length; i++) { frag.appendChild(renderRow(list[i], base + i + 1)); }
    tbody.replaceChildren(frag);
    updateBar();
  }

  var filterTimer = null;
  filter.addEventListener('input', function () {
    if (server) {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(function () { ask({ filter: filter.value }); }, 350);
      return;
    }
    term = filter.value.toLowerCase();
    if (edit) {
      // On ne supprime que ce qui est visible : les lignes masquees par le filtre sont deselectionnees.
      var visible = {};
      visibleRows().forEach(function (r) { visible[r.i] = true; });
      Object.keys(selected).forEach(function (k) { if (!visible[k]) { delete selected[k]; } });
    }
    renderBody();
  });

  if (edit) {
    addBtn.addEventListener('click', startInsert);
    selectAll.addEventListener('change', function () {
      var on = selectAll.checked;
      visibleRows().forEach(function (r) { if (on) { selected[r.i] = true; } else { delete selected[r.i]; } });
      renderBody();
    });
    delBtn.addEventListener('click', function () {
      if (busy || selectedCount() === 0) { return; }
      clearOp();
      vscode.postMessage({ type: 'deleteRows', token: data.token,
        rowIndexes: Object.keys(selected).map(Number) });
      setBusy(true);
    });
  }

  function syncSort() {
    var s = server ? data.browse.sort : null;
    sortCol = s ? s.col : -1;
    asc = s ? s.dir === 'asc' : true;
  }

  window.addEventListener('message', function (event) {
    var m = event.data;
    if (!m) { return; }
    if (m.type === 'total') {
      if (server && m.filter === data.browse.filter) { data.browse.total = m.total; updatePager(); }
      return;
    }
    // Une page chargée porte le NOUVEAU jeton (il remplace l'ancien) : elle n'est donc pas comparée.
    if (m.type !== 'page' && m.token !== data.token) { return; }
    if (m.type === 'pageError') { showOp('ko', m.message); updatePager(); return; }
    if (m.type === 'page') {
      data.token = m.token;
      data.browse = m.browse;
      data.summary = m.summary;
      sqlPre.textContent = m.sql;
      rows = m.rows.map(function (c, i) { return { i: i, c: c }; });
      selected = {}; editing = null; inserting = null; busy = false;
      deletedCount = 0; insertedCount = 0;
      if (document.activeElement !== filter) { filter.value = m.browse.filter; }
      syncSort(); clearOp(); updateHeaders(); renderBody();
      wrap.scrollTop = 0;
      return;
    }
    if (m.type !== 'opResult') { return; }
    busy = false;
    if (!m.ok) {
      if (m.cancelled) { clearOp(); } else { showOp('ko', m.message); }
      renderBody();
      return;
    }
    if (m.op === 'update') {
      var target = rows.filter(function (x) { return x.i === m.rowIndex; })[0];
      if (target) { target.c = m.values; }
      editing = null;
      showOp('ok', 'Ligne enregistrée.');
    } else if (m.op === 'delete') {
      var gone = {};
      m.rowIndexes.forEach(function (i) { gone[i] = true; delete selected[i]; });
      rows = rows.filter(function (x) { return !gone[x.i]; });
      deletedCount += m.rowIndexes.length;
      if (editing && gone[editing.i]) { editing = null; }
      showOp('ok', plural(m.rowIndexes.length, 'ligne supprimée', 'lignes supprimées') + '.');
    } else if (m.op === 'insert') {
      if (m.row) { rows.unshift({ i: m.rowIndex, c: m.row }); }
      insertedCount++;
      inserting = null;
      showOp('ok', m.message || 'Ligne ajoutée.');
    }
    renderBody();
  });

  syncSort();
  updateHeaders();
  renderBody();
  vscode.postMessage({ type: 'ready', token: data.token });
})();
`;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

export class ResultsPanel {
  private panel?: vscode.WebviewPanel;
  private last?: State;
  private token = '';

  /** Résultat d'une requête libre : lecture seule, tri et filtre appliqués à la page affichée. */
  showResult(connection: string, sql: string, result: QueryResult, badges?: string[]): void {
    let summary: string;
    if (result.columns.length > 0) {
      summary = plural(result.rowCount, 'ligne', 'lignes');
      if (result.truncated) {
        summary += ` (affichage limité aux ${result.rows.length} premières)`;
      }
    } else {
      const cmd = result.command ? `${result.command} · ` : '';
      summary = `${cmd}${plural(result.affectedRows ?? 0, 'ligne affectée', 'lignes affectées')}`;
    }
    if (result.statements && result.statements > 1) {
      summary += ` · ${result.statements} instructions exécutées (résultat de la dernière)`;
    }
    summary += ` · ${result.durationMs} ms`;

    this.last = { columns: result.columns, rows: result.rows.map((r) => [...r]) };
    this.render({
      kind: 'result',
      token: '',
      connection,
      sql,
      columns: result.columns,
      rows: result.rows,
      summary,
      badges,
    });
  }

  /**
   * Aperçu paginé d'une table ou d'une vue. La page, le tri et le filtre sont exécutés par le
   * serveur (la page affichée n'est qu'une fenêtre sur la table) ; si la table a une clé primaire,
   * les lignes peuvent être ajoutées, modifiées et supprimées.
   */
  async openTable(src: TableSource): Promise<void> {
    const b: BrowseState = {
      src,
      offset: 0,
      pageSize: this.clampPageSize(src.pageSize),
      sort: null,
      filter: '',
      hasNext: false,
      total: undefined,
      loadSeq: 0,
      countSeq: 0,
    };
    let page: Page;
    try {
      page = await this.fetchPage(b);
    } catch (err) {
      this.showError(src.connectionName, `Aperçu de ${src.container}.${src.table}`, errorMessage(err));
      return;
    }
    b.hasNext = page.hasNext;

    const state: State = { columns: page.columns, rows: page.rows.map((r) => [...r]), browse: b };
    let editInfo: EditInfo | undefined;
    let readOnlyReason: string | undefined;
    if (src.readOnly) {
      readOnlyReason = 'connexion en lecture seule';
    } else if (src.isView) {
      readOnlyReason = 'les vues ne sont pas modifiables';
    } else {
      const planned = planEditing(src.dbType, page.columns, src.tableColumns);
      if ('plan' in planned) {
        state.spec = src;
        state.plan = planned.plan;
        editInfo = {
          table: src.table,
          pk: planned.plan.pk,
          editable: planned.plan.editable,
          insertable: planned.plan.insertable,
          hasDefault: planned.plan.hasDefault,
          nullable: planned.plan.nullable,
        };
      } else {
        readOnlyReason = planned.reason;
      }
    }
    this.last = state;
    this.render({
      kind: 'result',
      token: '',
      connection: src.connectionName,
      sql: page.sql,
      columns: page.columns,
      rows: page.rows,
      summary: this.pageSummary(page),
      edit: editInfo,
      readOnlyReason,
      browse: this.browseInfo(b),
      badges: src.badges,
    });
    this.startCount(b);
  }

  /** Taille de page bornée : jamais plus que le maximum de lignes conservées par résultat. */
  private clampPageSize(n: number): number {
    const maxRows = vscode.workspace.getConfiguration('dbExplorer').get<number>('maxRows', 5000);
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, maxRows - 1));
    const wanted = Number.isFinite(n) ? Math.floor(n) : 200;
    return Math.min(limit, Math.max(1, wanted));
  }

  private async fetchPage(b: BrowseState): Promise<Page> {
    const { src } = b;
    const query = buildPageQuery({
      dbType: src.dbType,
      container: src.container,
      table: src.table,
      columns: src.tableColumns,
      pageSize: b.pageSize,
      offset: b.offset,
      sort: b.sort ? { column: src.tableColumns[b.sort.col].name, dir: b.sort.dir } : undefined,
      filter: b.filter,
    });
    const driver = await src.getDriver();
    const res = await driver.query(query.sql, query.params);
    return {
      columns: res.columns,
      rows: res.rows.slice(0, b.pageSize),
      hasNext: res.rows.length > b.pageSize,
      durationMs: res.durationMs,
      sql: b.filter ? `${query.sql}\n-- filtre : « ${b.filter} »` : query.sql,
    };
  }

  private pageSummary(page: Page): string {
    return `${plural(page.rows.length, 'ligne', 'lignes')} · ${page.durationMs} ms`;
  }

  private browseInfo(b: BrowseState): BrowseInfo {
    return {
      offset: b.offset,
      pageSize: b.pageSize,
      hasNext: b.hasNext,
      total: b.total,
      sort: b.sort,
      filter: b.filter,
      isView: b.src.isView,
    };
  }

  /**
   * Compte les lignes (pour le filtre courant) en arrière-plan : sur une grosse table un COUNT(*)
   * peut être long, il ne doit jamais retarder l'affichage d'une page. Le résultat est ignoré si un
   * comptage plus récent a démarré entre-temps.
   */
  private startCount(b: BrowseState): void {
    const seq = ++b.countSeq;
    const filter = b.filter;
    b.total = undefined;
    void (async () => {
      let total: number | null = null;
      try {
        const { src } = b;
        const query = buildCountQuery({
          dbType: src.dbType,
          container: src.container,
          table: src.table,
          columns: src.tableColumns,
          pageSize: 1,
          offset: 0,
          filter,
        });
        const res = await (await src.getDriver()).query(query.sql, query.params);
        const n = Number(res.rows[0]?.[0]);
        total = Number.isFinite(n) ? n : null;
      } catch {
        total = null;
      }
      if (b.countSeq !== seq || this.last?.browse !== b) {
        return;
      }
      b.total = total;
      this.postTotal(b);
    })();
  }

  private postTotal(b: BrowseState): void {
    void this.panel?.webview.postMessage({ type: 'total', total: b.total ?? null, filter: b.filter });
  }

  /** Après une insertion (+1) ou une suppression (−n) : le total connu reste juste sans recompter. */
  private adjustTotal(token: string, delta: number): void {
    const b = this.last?.browse;
    if (b && token === this.token && typeof b.total === 'number') {
      b.total = Math.max(0, b.total + delta);
      this.postTotal(b);
    }
  }

  private async browse(msg: Message): Promise<void> {
    const b = this.last?.browse;
    if (!b || !this.last) {
      return;
    }
    const failPage = (message: string) =>
      void this.panel?.webview.postMessage({ type: 'pageError', token: this.token, message });
    const next = { offset: b.offset, pageSize: b.pageSize, sort: b.sort, filter: b.filter };
    let recount = msg.refresh === true;

    if (msg.pageSize !== undefined) {
      if (typeof msg.pageSize !== 'number' || !Number.isInteger(msg.pageSize) || msg.pageSize < 1) {
        return failPage('Taille de page invalide.');
      }
      const size = this.clampPageSize(msg.pageSize);
      if (size !== b.pageSize) {
        next.pageSize = size;
        next.offset = 0;
      }
    }
    if ('sort' in msg) {
      const s = msg.sort as { col?: unknown; dir?: unknown } | null | undefined;
      if (s === null) {
        next.sort = null;
      } else if (
        s &&
        typeof s.col === 'number' &&
        Number.isInteger(s.col) &&
        s.col >= 0 &&
        s.col < b.src.tableColumns.length &&
        (s.dir === 'asc' || s.dir === 'desc')
      ) {
        next.sort = { col: s.col, dir: s.dir };
      } else {
        return failPage('Tri invalide.');
      }
      next.offset = 0;
    }
    if (msg.filter !== undefined) {
      if (typeof msg.filter !== 'string') {
        return failPage('Filtre invalide.');
      }
      const filter = msg.filter.trim().slice(0, 200);
      if (filter !== b.filter) {
        next.filter = filter;
        next.offset = 0;
        recount = true;
      }
    }
    if (msg.page === 'next') {
      if (!b.hasNext) {
        return failPage("Il n'y a pas de page suivante.");
      }
      next.offset += next.pageSize;
    } else if (msg.page === 'prev') {
      next.offset = Math.max(0, next.offset - next.pageSize);
    } else if (msg.page === 'first') {
      next.offset = 0;
    }

    const seq = ++b.loadSeq;
    let page: Page;
    try {
      page = await this.fetchPage({ ...b, ...next });
    } catch (err) {
      if (seq === b.loadSeq) {
        failPage(errorMessage(err));
      }
      return;
    }
    if (seq !== b.loadSeq || this.last?.browse !== b) {
      return; // une requête plus récente a pris le relais
    }

    Object.assign(b, next, { hasNext: page.hasNext });
    this.last.rows = page.rows.map((r) => [...r]);
    // Nouveau jeton : tout message ou toute réponse liés à l'ancienne page deviennent périmés.
    this.token = randomBytes(8).toString('hex');
    if (recount) {
      this.startCount(b);
    }
    void this.panel?.webview.postMessage({
      type: 'page',
      token: this.token,
      rows: page.rows,
      summary: this.pageSummary(page),
      sql: page.sql,
      browse: this.browseInfo(b),
    });
  }

  showError(connection: string, sql: string, message: string, badges?: string[]): void {
    this.last = undefined;
    this.render({
      kind: 'error',
      token: '',
      connection,
      sql,
      columns: [],
      rows: [],
      summary: 'erreur',
      error: message,
      badges,
    });
  }

  private render(payload: Payload): void {
    this.token = randomBytes(8).toString('hex');
    payload.token = this.token;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'dbExplorer.results',
        'Résultats SQL',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
      this.panel.webview.onDidReceiveMessage((msg: Message) => void this.onMessage(msg));
    } else {
      this.panel.reveal(undefined, true);
    }
    this.panel.webview.html = buildHtml(payload, randomBytes(16).toString('hex'));
  }

  /** Réponse à une opération : portée par le jeton de la page qui l'a demandée (ignorée si elle a changé). */
  private reply(token: string, message: Record<string, unknown>): void {
    void this.panel?.webview.postMessage({ type: 'opResult', token, ...message });
  }

  private async onMessage(msg: Message): Promise<void> {
    // Message venu d'une page déjà remplacée par un nouveau résultat : on l'ignore.
    if (!msg || msg.token !== this.token) {
      return;
    }
    const token = this.token;
    switch (msg.type) {
      case 'ready': {
        const b = this.last?.browse;
        if (b && b.total !== undefined) {
          this.postTotal(b);
        }
        break;
      }
      case 'browse':
        await this.browse(msg);
        break;
      case 'exportCsv':
        await this.exportCsv();
        break;
      case 'updateRow':
        await this.updateRow(token, msg.rowIndex, msg.changes);
        break;
      case 'deleteRows':
        await this.deleteRows(token, msg.rowIndexes);
        break;
      case 'insertRow':
        await this.insertRow(token, msg.values);
        break;
    }
  }

  /** Sur une connexion de production, demande confirmation avant une modification ou une insertion. */
  private async confirmProduction(spec: EditSpec, message: string): Promise<boolean> {
    if (!spec.production) {
      return true;
    }
    if (!vscode.workspace.getConfiguration('dbExplorer').get<boolean>('confirmOnProduction', true)) {
      return true;
    }
    const go = 'Confirmer';
    const choice = await vscode.window.showWarningMessage(
      `⚠ PRODUCTION : ${message}`,
      { modal: true, detail: 'Vous êtes connecté à une base de production.' },
      go,
    );
    return choice === go;
  }

  private async insertRow(token: string, values: unknown): Promise<void> {
    const fail = (message: string) => this.reply(token, { op: 'insert', ok: false, message });
    const st = this.last;
    if (!st?.spec || !st.plan) {
      return fail("Insertion impossible : ce résultat n'est pas modifiable.");
    }
    if (typeof values !== 'object' || values === null) {
      return fail('Valeurs invalides.');
    }
    const { spec, plan } = st;
    const rows = st.rows;

    const idx: number[] = [];
    const vals: (string | null)[] = [];
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      const j = Number(key);
      if (!Number.isInteger(j) || j < 0 || j >= st.columns.length || !plan.insertable[j]) {
        return fail(`La colonne « ${st.columns[j] ?? key} » ne peut pas être renseignée.`);
      }
      if (value !== null && typeof value !== 'string') {
        return fail('Valeur invalide.');
      }
      if (value === null && !plan.nullable[j]) {
        return fail(`La colonne « ${st.columns[j]} » n'accepte pas NULL.`);
      }
      idx.push(j);
      vals.push(value);
    }

    if (!(await this.confirmProduction(spec, `Insérer une ligne dans « ${spec.table} » ?`))) {
      return this.reply(token, { op: 'insert', ok: false, cancelled: true });
    }
    try {
      const driver = await spec.getDriver();
      const stmt = buildInsert(spec.dbType, spec.container, spec.table, st.columns, idx, vals);
      const res = await driver.insertRow(stmt.sql, stmt.params);

      // PostgreSQL renvoie la ligne (RETURNING). Sinon on la retrouve par sa clé primaire :
      // soit fournie à l'insertion, soit générée (auto-incrément).
      let row = res.row;
      if (!row) {
        const given = plan.pk.map((j) => {
          const k = idx.indexOf(j);
          return k >= 0 ? vals[k] : null;
        });
        let lookup: (string | null)[] | undefined;
        if (given.every((v) => v !== null)) {
          lookup = given;
        } else if (plan.pk.length === 1 && res.insertId) {
          lookup = [res.insertId];
        }
        if (lookup) {
          try {
            const sel = buildSelectRow(
              spec.dbType,
              spec.container,
              spec.table,
              plan.pk.map((j) => st.columns[j]),
              lookup,
            );
            row = (await driver.query(sel.sql, sel.params)).rows[0];
          } catch {
            // L'insertion est faite ; la relecture est facultative.
          }
        }
      }
      if (!row) {
        this.adjustTotal(token, 1);
        return this.reply(token, {
          op: 'insert',
          ok: true,
          message: "Ligne insérée. Actualisez l'aperçu pour la voir.",
        });
      }
      rows.push(row);
      this.adjustTotal(token, 1);
      this.reply(token, { op: 'insert', ok: true, rowIndex: rows.length - 1, row });
    } catch (err) {
      fail(errorMessage(err));
    }
  }

  private async updateRow(token: string, rowIndex: unknown, changes: unknown): Promise<void> {
    const fail = (message: string) => this.reply(token, { op: 'update', ok: false, message });
    const st = this.last;
    if (!st?.spec || !st.plan) {
      return fail("Modification impossible : ce résultat n'est pas modifiable.");
    }
    const rows = st.rows;
    const row = typeof rowIndex === 'number' ? rows[rowIndex] : undefined;
    if (!row || typeof changes !== 'object' || changes === null) {
      return fail('Ligne introuvable.');
    }
    const { spec, plan } = st;

    const setIdx: number[] = [];
    const setValues: (string | null)[] = [];
    for (const [key, value] of Object.entries(changes as Record<string, unknown>)) {
      const j = Number(key);
      if (!Number.isInteger(j) || j < 0 || j >= st.columns.length || !plan.editable[j]) {
        return fail(`La colonne « ${st.columns[j] ?? key} » n'est pas modifiable.`);
      }
      if (value !== null && typeof value !== 'string') {
        return fail('Valeur invalide.');
      }
      if (value === null && !plan.nullable[j]) {
        return fail(`La colonne « ${st.columns[j]} » n'accepte pas NULL.`);
      }
      if (value !== row[j]) {
        setIdx.push(j);
        setValues.push(value);
      }
    }
    if (setIdx.length === 0) {
      return this.reply(token, { op: 'update', ok: true, rowIndex, values: row });
    }

    if (!(await this.confirmProduction(spec, `Modifier 1 ligne de « ${spec.table} » ?`))) {
      return this.reply(token, { op: 'update', ok: false, cancelled: true });
    }
    try {
      const driver = await spec.getDriver();
      const pkValues = plan.pk.map((j) => row[j]);
      await driver.executeBatch([
        buildUpdate(spec.dbType, spec.container, spec.table, st.columns, setIdx, setValues, plan.pk, pkValues),
      ]);

      // On relit la ligne : le serveur a pu normaliser les valeurs (12.5 → 12.50, etc.).
      let values: Row = [...row];
      setIdx.forEach((j, k) => (values[j] = setValues[k]));
      try {
        const sel = buildSelectRow(
          spec.dbType,
          spec.container,
          spec.table,
          plan.pk.map((j) => st.columns[j]),
          pkValues,
        );
        const fresh = await driver.query(sel.sql, sel.params);
        if (fresh.rows[0]) {
          values = fresh.rows[0];
        }
      } catch {
        // La modification est faite ; à défaut de relecture on garde les valeurs saisies.
      }
      rows[rowIndex as number] = values;
      this.reply(token, { op: 'update', ok: true, rowIndex, values });
    } catch (err) {
      fail(errorMessage(err));
    }
  }

  private async deleteRows(token: string, rowIndexes: unknown): Promise<void> {
    const fail = (message: string) => this.reply(token, { op: 'delete', ok: false, message });
    const st = this.last;
    if (!st?.spec || !st.plan) {
      return fail("Suppression impossible : ce résultat n'est pas modifiable.");
    }
    if (!Array.isArray(rowIndexes)) {
      return fail('Sélection invalide.');
    }
    const { spec, plan } = st;
    const rows = st.rows;
    const indexes = [...new Set(rowIndexes)].filter(
      (i): i is number => typeof i === 'number' && Number.isInteger(i) && !!rows[i],
    );
    if (indexes.length === 0) {
      return this.reply(token, { op: 'delete', ok: true, rowIndexes: [] });
    }

    // Clés primaires relevées AVANT la confirmation : ce sont celles que l'utilisateur a vues.
    const pkRows = indexes.map((i) => plan.pk.map((j) => (rows[i] as Row)[j]));

    const remove = 'Supprimer';
    const choice = await vscode.window.showWarningMessage(
      `${spec.production ? '⚠ PRODUCTION : s' : 'S'}upprimer ${plural(indexes.length, 'ligne', 'lignes')} de « ${spec.table} » ?`,
      { modal: true, detail: 'Cette action est irréversible.' },
      remove,
    );
    if (choice !== remove) {
      return this.reply(token, { op: 'delete', ok: false, cancelled: true });
    }

    try {
      const driver = await spec.getDriver();
      await driver.executeBatch(
        buildDeletes(
          spec.dbType,
          spec.container,
          spec.table,
          plan.pk.map((j) => st.columns[j]),
          pkRows,
        ),
      );
      indexes.forEach((i) => (rows[i] = null));
      this.adjustTotal(token, -indexes.length);
      this.reply(token, { op: 'delete', ok: true, rowIndexes: indexes });
    } catch (err) {
      fail(errorMessage(err));
    }
  }

  private async exportCsv(): Promise<void> {
    if (!this.last) {
      return;
    }
    const setting = vscode.workspace.getConfiguration('dbExplorer').get<string>('csvSeparator', ',');
    const sep = setting === 'tab' ? '\t' : setting;
    const escape = (v: string | null): string => {
      if (v === null) {
        return '';
      }
      return v.includes(sep) || /["\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    };
    const rows = this.last.rows.filter((r): r is Row => r !== null);
    const lines = [this.last.columns, ...rows].map((r) => r.map(escape).join(sep));

    const uri = await vscode.window.showSaveDialog({
      filters: { CSV: ['csv'] },
      saveLabel: 'Exporter',
    });
    if (!uri) {
      return;
    }
    // BOM UTF-8 pour qu'Excel détecte correctement les accents.
    const content = Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
    await vscode.workspace.fs.writeFile(uri, content);
    vscode.window.showInformationMessage(`Export CSV enregistré : ${uri.fsPath}`);
  }
}

interface Message {
  type?: string;
  token?: string;
  rowIndex?: unknown;
  changes?: unknown;
  rowIndexes?: unknown;
  values?: unknown;
  page?: unknown;
  pageSize?: unknown;
  sort?: unknown;
  filter?: unknown;
  refresh?: unknown;
}

function buildHtml(payload: Payload, nonce: string): string {
  // Le JSON est placé dans une balise <script type="application/json"> : on neutralise "<".
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Résultats SQL</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<div id="root"></div>
<script id="data" type="application/json" nonce="${nonce}">${data}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

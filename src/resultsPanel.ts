import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildCountQuery, buildPageQuery, keysetColumns } from './browse';
import {
  buildDeletes,
  buildInsert,
  buildSelectRow,
  buildUpdate,
  EditPlan,
  planEditing,
} from './editing';
import { EXTENSIONS, ExportFormat, ExportOptions, formatRows, RowFormatter, streamTable } from './exporter';
import { ColumnInfo, DbDriver, DbType, QueryResult } from './types';
import { errorMessage, quoteIdent } from './util';

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
/** Égalité exacte sur une colonne (arrivée par une clé étrangère). */
type WhereState = { col: number; value: string };

/** Vue précédente d'un aperçu, pour le bouton « Retour » après un saut par clé étrangère. */
interface NavFrame {
  src: TableSource;
  offset: number;
  pageSize: number;
  sort: SortState;
  filter: string;
  where?: WhereState;
}

/** État de navigation d'un aperçu : page, taille, tri et filtre sont gérés côté serveur. */
interface BrowseState {
  src: TableSource;
  offset: number;
  pageSize: number;
  sort: SortState;
  filter: string;
  where?: WhereState;
  hasNext: boolean;
  /** Pagination par clé : keys[p] = valeurs de clé de la dernière ligne de la page p-1 (absent = pagination par OFFSET). */
  keys: (unknown[] | undefined)[];
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
  where?: { column: string; value: string };
  /** Table d'où l'on vient (bouton « Retour »). */
  back?: string;
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
  kinds: string[];
  /** Résultat d'une requête libre : modification et suppression seulement. */
  noInsert?: boolean;
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
  /** Par colonne : table référencée si c'est une clé étrangère (lien cliquable). */
  fks?: ({ container: string; table: string; column: string } | null)[];
  /** Script de plusieurs instructions : un onglet par résultat. */
  sets?: { label: string; title: string }[];
  activeSet?: number;
}

interface State {
  columns: string[];
  /** Lignes d'origine ; null = supprimée (les indices restent stables pour la page). */
  rows: (Row | null)[];
  spec?: EditSpec;
  plan?: EditPlan;
  browse?: BrowseState;
  /** Pile des vues précédentes (navigation par clé étrangère). */
  nav?: NavFrame[];
  /** Dialecte connu (requis pour exporter en INSERT SQL d'un résultat de requête). */
  dbType?: DbType;
  /** Résultat d'une requête libre modifiable : pas d'insertion (la ligne ne correspondrait pas à la requête). */
  noInsert?: boolean;
}

interface MultiState {
  connection: string;
  sql: string;
  sets: QueryResult[];
  badges?: string[];
  dbType?: DbType;
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
  a.fkl { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
  a.fkl:hover { color: var(--vscode-textLink-activeForeground); }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 4px 1px 10px; border-radius: 12px;
          border: 1px solid var(--vscode-focusBorder); }
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
  td.editcell textarea.mono { font-family: var(--vscode-editor-font-family, monospace); }
  td.editcell textarea.invalid { border-color: var(--vscode-inputValidation-errorBorder, #be1100); }
  td.editcell input.picker { box-sizing: border-box; font: inherit; padding: 1px 3px; width: 12.5em;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
  td.editcell .flags { display: flex; flex-direction: column; gap: 1px; }
  tr.inserting td.editcell textarea::placeholder { font-style: italic; }
  td.editcell label { display: flex; align-items: center; gap: 3px; white-space: nowrap;
                      color: var(--vscode-descriptionForeground); font-size: 0.85em; padding-top: 3px; }
  td.readonlycell { color: var(--vscode-descriptionForeground); }
  .tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; }
  .tabs .tab { border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground);
               border-radius: 3px; padding: 3px 10px; }
  .tabs .tab:hover { background: var(--vscode-toolbar-hoverBackground); }
  .tabs .tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
                      border-color: var(--vscode-button-background); }
  .tabs .tabinfo { opacity: 0.8; font-size: 0.85em; }
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

  if (data.sets) {
    var tabs = el('div', 'tabs');
    tabs.setAttribute('role', 'tablist');
    data.sets.forEach(function (t, i) {
      var b = el('button', 'tab' + (i === data.activeSet ? ' active' : ''), t.label);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', i === data.activeSet ? 'true' : 'false');
      b.title = 'Résultat ' + t.label + ' : ' + t.title;
      b.appendChild(el('span', 'tabinfo', ' ' + t.title));
      b.addEventListener('click', function () {
        if (i !== data.activeSet) { vscode.postMessage({ type: 'selectSet', index: i, token: data.token }); }
      });
      tabs.appendChild(b);
    });
    root.appendChild(tabs);
  }

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
  var fks = data.fks || [];
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
  filter.placeholder = server ? 'Filtrer (toute la table) : texte, ou prix > 20 ; nom contient x' : 'Filtrer les lignes…';
  if (server) { filter.value = data.browse.filter; }
  var info = el('span', 'muted');
  var spacer = el('span', 'spacer');
  var delBtn = null;
  var addBtn = null;
  if (edit) {
    delBtn = el('button', 'danger', 'Supprimer la sélection');
    if (!edit.noInsert) { addBtn = el('button', 'primary', 'Ajouter une ligne'); }
  }
  var exportBtn = el('button', '', 'Exporter…');
  exportBtn.title = 'Exporter en CSV, JSON ou instructions INSERT';
  exportBtn.addEventListener('click', function () { vscode.postMessage({ type: 'export', token: data.token }); });
  bar.appendChild(filter);
  bar.appendChild(info);
  bar.appendChild(spacer);
  if (addBtn) { bar.appendChild(addBtn); }
  if (delBtn) { bar.appendChild(delBtn); }
  bar.appendChild(exportBtn);
  root.appendChild(bar);

  // Navigation par clé étrangère : retour à la table précédente, filtre d'égalité en cours.
  var navBar = el('div', 'bar');
  root.insertBefore(navBar, bar);
  function renderNav() {
    navBar.replaceChildren();
    var b = data.browse;
    if (!b || (!b.back && !b.where)) { navBar.style.display = 'none'; return; }
    navBar.style.display = '';
    if (b.back) {
      var back = el('button', '', '← ' + b.back);
      back.title = 'Revenir à la table précédente';
      back.addEventListener('click', function () { vscode.postMessage({ type: 'back', token: data.token }); });
      navBar.appendChild(back);
    }
    if (b.where) {
      var chip = el('span', 'chip');
      chip.appendChild(document.createTextNode(b.where.column + ' = ' + b.where.value));
      var x = el('button', 'icon', '✕');
      x.title = 'Retirer ce filtre (afficher toute la table)';
      x.setAttribute('aria-label', 'Retirer le filtre ' + b.where.column);
      x.addEventListener('click', function () { ask({ where: null }); });
      chip.appendChild(x);
      navBar.appendChild(chip);
    }
  }

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
      var key = edit && edit.pk.indexOf(i) !== -1 ? '🔑 ' : (fks[i] ? '↗ ' : '');
      if (fks[i]) { th.title = 'Clé étrangère → ' + fks[i].table + '.' + fks[i].column; }
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
      if (addBtn) { addBtn.disabled = busy; }
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

  // --- Éditeurs adaptés au type : JSON (indentation, validation) et dates / heures (sélecteur natif, « maintenant »).
  function kindOf(j) { return (edit.kinds && edit.kinds[j]) || ''; }
  var FMT = {
    date: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
    datetime: '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}(:[0-9]{2})?$',
    time: '^[0-9]{2}:[0-9]{2}(:[0-9]{2})?$'
  };
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function nowText(kind) {
    var d = new Date();
    var ymd = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    var hms = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    return kind === 'date' ? ymd : (kind === 'time' ? hms : ymd + ' ' + hms);
  }
  function jsonProblem(text) {
    try { JSON.parse(text); return ''; } catch (e) { return String(e.message || e); }
  }
  function sameJson(a, b) {
    try { return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)); } catch (e) { return false; }
  }
  function decorate(box, input, j) {
    var kind = kindOf(j);
    if (!kind) { return; }
    var fire = function () { input.dispatchEvent(new Event('input', { bubbles: true })); };
    if (kind === 'json') {
      input.classList.add('mono');
      var fmt = el('button', 'icon', '{ }');
      fmt.type = 'button';
      fmt.title = 'Mettre en forme (indenter) le JSON';
      fmt.setAttribute('aria-label', 'Mettre en forme le JSON');
      fmt.disabled = busy;
      var check = function () {
        var t = input.value.trim();
        var p = t === '' ? '' : jsonProblem(t);
        input.classList.toggle('invalid', p !== '');
        input.title = p ? 'JSON invalide : ' + p : 'Ctrl+Entrée pour enregistrer';
      };
      input.addEventListener('input', check);
      fmt.addEventListener('click', function () {
        try { input.value = JSON.stringify(JSON.parse(input.value), null, 2); } catch (e) { check(); return; }
        fire();
      });
      box.appendChild(fmt);
      setTimeout(check, 0);
      return;
    }
    var re = new RegExp(FMT[kind]);
    var pick = el('input', 'picker');
    pick.type = kind === 'date' ? 'date' : (kind === 'time' ? 'time' : 'datetime-local');
    if (kind !== 'date') { pick.step = '1'; }
    pick.disabled = busy;
    pick.setAttribute('aria-label', data.columns[j] + ' (sélecteur)');
    var sync = function () {
      var t = input.value.trim();
      pick.value = re.test(t) ? (kind === 'datetime' ? t.replace(' ', 'T') : t) : '';
    };
    sync();
    input.addEventListener('input', sync);
    pick.addEventListener('change', function () {
      if (!pick.value) { return; }
      var v = kind === 'datetime' ? pick.value.replace('T', ' ') : pick.value;
      if (v.indexOf('.') !== -1) { v = v.split('.')[0]; }
      if (kind !== 'date' && v.length === (kind === 'time' ? 5 : 16)) { v += ':00'; }
      input.value = v;
      fire();
    });
    var now = el('button', 'icon', '⏱');
    now.type = 'button';
    now.title = 'Maintenant';
    now.setAttribute('aria-label', 'Mettre la date et l’heure actuelles');
    now.disabled = busy;
    now.addEventListener('click', function () { input.value = nowText(kind); fire(); });
    box.appendChild(pick);
    box.appendChild(now);
  }
  function enterSaves(j, e) {
    // JSON multiligne : Entrée insère une ligne, Ctrl/Cmd+Entrée enregistre.
    return e.key === 'Enter' && !e.shiftKey && (kindOf(j) !== 'json' || e.ctrlKey || e.metaKey);
  }


  function startEdit(i) {
    if (busy) { return; }
    var r = rows.filter(function (x) { return x.i === i; })[0];
    if (!r) { return; }
    inserting = null;
    editing = { i: i, vals: {}, nul: {} };
    data.columns.forEach(function (_n, j) {
      editing.vals[j] = r.c[j] === null ? '' : r.c[j];
      editing.nul[j] = r.c[j] === null;
      if (kindOf(j) === 'json' && r.c[j] !== null && edit.editable[j]) {
        try { editing.vals[j] = JSON.stringify(JSON.parse(r.c[j]), null, 2); } catch (e) { /* laissé tel quel */ }
      }
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
    var bad = '';
    data.columns.forEach(function (_n, j) {
      if (!edit.editable[j]) { return; }
      var v = editing.nul[j] ? null : editing.vals[j];
      if (v !== null && kindOf(j) === 'json') {
        if (r.c[j] !== null && sameJson(v, r.c[j])) { return; }  // seulement mis en forme : pas une modification
        var pb = jsonProblem(v);
        if (pb && !bad) { bad = 'JSON invalide pour « ' + data.columns[j] + ' » : ' + pb; }
      }
      if (v !== r.c[j]) { changes[j] = v; count++; }
    });
    if (bad) { showOp('ko', bad); return; }
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
        else if (enterSaves(j, e)) { e.preventDefault(); saveEdit(); }
      });
      setTimeout(grow, 0);
      box.appendChild(input);
      decorate(box, input, j);
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
      if (c.mode === 'value' && kindOf(j) === 'json') {
        var pj = jsonProblem(c.val);
        if (pj) {
          showOp('ko', 'JSON invalide pour « ' + data.columns[j] + ' » : ' + pj);
          return;
        }
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
        else if (enterSaves(j, e)) { e.preventDefault(); saveInsert(); }
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
      decorate(box, input, j);
      if (flags.childNodes.length) { box.appendChild(flags); }
      td.appendChild(box);
      tr.appendChild(td);
    });
    return tr;
  }

  function fkLink(r, j) {
    var a = el('a', 'fkl', r.c[j]);
    a.href = '#';
    a.title = 'Ouvrir ' + fks[j].table + ' où ' + fks[j].column + ' = ' + r.c[j];
    a.addEventListener('click', function (e) {
      e.preventDefault();
      if (busy) { return; }
      vscode.postMessage({ type: 'followFk', token: data.token, rowIndex: r.i, col: j });
      showOp('busy', 'Ouverture de ' + fks[j].table + '…');
    });
    return a;
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
      if (server && fks[j] && r.c[j] !== null) {
        td.appendChild(fkLink(r, j));
      } else {
        cellText(td, r.c[j]);
      }
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
    if (addBtn) { addBtn.addEventListener('click', startInsert); }
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
      syncSort(); clearOp(); renderNav(); updateHeaders(); renderBody();
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
  renderNav();
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
  private multi?: MultiState;

  /** Résultat d'une requête libre : lecture seule, tri et filtre appliqués à la page affichée. */
  showResult(
    connection: string,
    sql: string,
    result: QueryResult,
    badges?: string[],
    dbType?: DbType,
    editable?: { spec: EditSpec; readOnly?: boolean },
  ): void {
    if (result.sets && result.sets.length > 1) {
      this.multi = { connection, sql, sets: result.sets, badges, dbType };
      this.showSet(result.sets.length - 1);
      return;
    }
    this.multi = undefined;
    this.renderResult(connection, sql, result, badges, dbType, undefined, editable);
  }

  /** Affiche le résultat n° `index` d'un script (onglet choisi). */
  private showSet(index: number): void {
    const m = this.multi;
    if (!m) {
      return;
    }
    const set = m.sets[index];
    this.renderResult(m.connection, m.sql, set, m.badges, m.dbType, {
      sets: m.sets.map((r, i) => ({
        label: `${i + 1}`,
        title: r.columns.length > 0 ? `${plural(r.rowCount, 'ligne', 'lignes')}` : `${r.command ?? 'OK'} · ${plural(r.affectedRows ?? 0, 'ligne affectée', 'lignes affectées')}`,
      })),
      activeSet: index,
      position: `Résultat ${index + 1}/${m.sets.length}`,
    });
  }

  private renderResult(
    connection: string,
    sql: string,
    result: QueryResult,
    badges?: string[],
    dbType?: DbType,
    multi?: { sets: { label: string; title: string }[]; activeSet: number; position: string },
    editable?: { spec: EditSpec; readOnly?: boolean },
  ): void {
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
    if (multi) {
      summary = `${multi.position} · ${summary}`;
    } else if (result.statements && result.statements > 1) {
      summary += ` · ${result.statements} instructions exécutées (résultat de la dernière)`;
    }
    if (result.durationMs > 0) {
      summary += ` · ${result.durationMs} ms`;
    }

    const state: State = { columns: result.columns, rows: result.rows.map((r) => [...r]), dbType };
    let edit: EditInfo | undefined;
    let readOnlyReason: string | undefined;
    if (editable && result.columns.length > 0) {
      if (editable.readOnly) {
        readOnlyReason = 'connexion en lecture seule';
      } else {
        const planned = planEditing(editable.spec.dbType, result.columns, editable.spec.tableColumns);
        if ('plan' in planned) {
          state.spec = editable.spec;
          state.plan = planned.plan;
          state.noInsert = true;
          edit = { table: editable.spec.table, ...planned.plan, noInsert: true };
        } else {
          readOnlyReason = planned.reason;
        }
      }
    }
    this.last = state;
    this.render({
      kind: 'result',
      token: '',
      connection,
      sql,
      columns: result.columns,
      rows: result.rows,
      summary,
      edit,
      readOnlyReason,
      badges,
      sets: multi?.sets,
      activeSet: multi?.activeSet,
    });
  }

  /**
   * Aperçu paginé d'une table ou d'une vue. La page, le tri et le filtre sont exécutés par le
   * serveur (la page affichée n'est qu'une fenêtre sur la table) ; si la table a une clé primaire,
   * les lignes peuvent être ajoutées, modifiées et supprimées.
   */
  async openTable(
    src: TableSource,
    opts: { where?: WhereState; nav?: NavFrame[]; init?: NavFrame } = {},
  ): Promise<void> {
    this.multi = undefined;
    const init = opts.init;
    const b: BrowseState = {
      src,
      offset: init?.offset ?? 0,
      pageSize: this.clampPageSize(init?.pageSize ?? src.pageSize),
      sort: init?.sort ?? null,
      filter: init?.filter ?? '',
      where: init?.where ?? opts.where,
      hasNext: false,
      keys: [],
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

    const state: State = {
      columns: page.columns,
      rows: page.rows.map((r) => [...r]),
      browse: b,
      nav: opts.nav ?? [],
    };
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
          kinds: planned.plan.kinds,
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
      fks: page.columns.map((name) => src.tableColumns.find((c) => c.name === name)?.references ?? null),
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
      where: b.where ? { column: src.tableColumns[b.where.col].name, value: b.where.value } : undefined,
      after: b.offset > 0 ? b.keys[Math.round(b.offset / b.pageSize)] : undefined,
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
      where: b.where
        ? { column: b.src.tableColumns[b.where.col].name, value: b.where.value }
        : undefined,
      back: this.last?.nav?.length ? this.last.nav[this.last.nav.length - 1].src.table : undefined,
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
          where: b.where ? { column: src.tableColumns[b.where.col].name, value: b.where.value } : undefined,
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
    const next = {
      offset: b.offset,
      pageSize: b.pageSize,
      sort: b.sort,
      filter: b.filter,
      where: b.where,
      keys: b.keys,
    };
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
    if ('where' in msg) {
      // Seul le retrait du filtre d'égalité vient de la page ; sa pose passe par followFk.
      if (msg.where !== null) {
        return failPage('Filtre invalide.');
      }
      next.where = undefined;
      next.offset = 0;
      recount = true;
    }
    if (msg.page === undefined && msg.refresh !== true) {
      next.keys = []; // pageSize / tri / filtre changés : les anciens repères ne valent plus
    }
    if (msg.page === 'next') {
      if (!b.hasNext) {
        return failPage("Il n'y a pas de page suivante.");
      }
      const ks = keysetColumns({
        dbType: b.src.dbType,
        columns: b.src.tableColumns,
        sort: next.sort ? { column: b.src.tableColumns[next.sort.col].name, dir: next.sort.dir } : undefined,
      });
      const lastRow = this.last.rows[this.last.rows.length - 1];
      if (ks && lastRow) {
        const idx = ks.map((c) => this.last!.columns.indexOf(c.name));
        const vals = idx.map((i) => (i >= 0 ? lastRow[i] : undefined));
        if (vals.every((v) => v !== null && v !== undefined)) {
          next.keys = [...next.keys];
          next.keys[Math.round((next.offset + next.pageSize) / next.pageSize)] = vals;
        }
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

  /** Clic sur une valeur de clé étrangère : ouvre la table référencée, filtrée sur cette valeur. */
  private async followFk(msg: Message): Promise<void> {
    const st = this.last;
    const b = st?.browse;
    if (!st || !b) {
      return;
    }
    const fail = (message: string) =>
      void this.panel?.webview.postMessage({ type: 'pageError', token: this.token, message });
    const col = msg.col;
    const ref =
      typeof col === 'number' && Number.isInteger(col) ? st.columns[col] && b.src.tableColumns.find((c) => c.name === st.columns[col])?.references : undefined;
    const row = typeof msg.rowIndex === 'number' ? st.rows[msg.rowIndex] : undefined;
    const value = row && typeof col === 'number' ? row[col] : undefined;
    if (!ref || value === null || value === undefined) {
      return fail("Cette valeur n'est pas une clé étrangère suivie.");
    }
    try {
      const driver = await b.src.getDriver();
      const [tables, cols] = await Promise.all([
        driver.listTables(ref.container),
        driver.listColumns(ref.container, ref.table),
      ]);
      if (this.last !== st) {
        return; // la vue a changé pendant la lecture
      }
      const refCol = cols.findIndex((c) => c.name === ref.column);
      if (refCol < 0) {
        return fail(`Colonne « ${ref.column} » introuvable dans ${ref.table}.`);
      }
      const frame: NavFrame = {
        src: b.src,
        offset: b.offset,
        pageSize: b.pageSize,
        sort: b.sort,
        filter: b.filter,
        where: b.where,
      };
      const nav = [...(st.nav ?? []), frame].slice(-20);
      await this.openTable(
        {
          ...b.src,
          container: ref.container,
          table: ref.table,
          tableColumns: cols,
          isView: tables.find((t) => t.name === ref.table)?.isView ?? false,
        },
        { where: { col: refCol, value }, nav },
      );
    } catch (err) {
      fail(errorMessage(err));
    }
  }

  /** Retour à la table d'où l'on est venu (page, tri et filtre retrouvés ; données relues). */
  private async back(): Promise<void> {
    const st = this.last;
    const nav = st?.nav;
    if (!st || !nav || nav.length === 0) {
      return;
    }
    const frame = nav[nav.length - 1];
    await this.openTable(frame.src, { init: frame, nav: nav.slice(0, -1) });
  }

  showError(connection: string, sql: string, message: string, badges?: string[]): void {
    this.last = undefined;
    this.multi = undefined;
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
      case 'followFk':
        await this.followFk(msg);
        break;
      case 'back':
        await this.back();
        break;
      case 'selectSet': {
        const i = Number(msg.index);
        if (this.multi && Number.isInteger(i) && i >= 0 && i < this.multi.sets.length) {
          this.showSet(i);
        }
        break;
      }
      case 'export':
      case 'exportCsv':
        await this.exportData();
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
    if (!st?.spec || !st.plan || st.noInsert) {
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

  /** Exporte le résultat affiché (ou toute la table pour un aperçu) en CSV, JSON ou INSERT SQL. */
  private async exportData(): Promise<void> {
    const last = this.last;
    if (!last) {
      return;
    }
    const b = last.browse;
    const dbType = b ? b.src.dbType : last.dbType;

    const formats: { label: string; description: string; format: ExportFormat }[] = [
      { label: 'CSV', description: 'tableur (Excel, LibreOffice…)', format: 'csv' },
      { label: 'JSON', description: 'tableau d\'objets, un par ligne', format: 'json' },
    ];
    if (dbType) {
      formats.push({ label: 'INSERT SQL', description: 'instructions INSERT rejouables', format: 'sql' });
    }
    const pickedFormat = await vscode.window.showQuickPick(formats, { placeHolder: 'Format d\'export' });
    if (!pickedFormat) {
      return;
    }
    const format = pickedFormat.format;

    let whole = false;
    if (b) {
      const shown = last.rows.filter((r) => r !== null).length;
      const active = [b.filter ? `filtre « ${b.filter} »` : '', b.where ? 'filtre de navigation' : '', b.sort ? 'tri en cours' : '']
        .filter(Boolean)
        .join(', ');
      const scope = await vscode.window.showQuickPick(
        [
          { label: 'Page affichée', description: `${shown} ligne(s), modifications comprises`, whole: false },
          {
            label: 'Toute la table',
            description: active ? `lue sur le serveur — ${active}` : 'lue sur le serveur par lots',
            whole: true,
          },
        ],
        { placeHolder: 'Que faut-il exporter ?' },
      );
      if (!scope) {
        return;
      }
      whole = scope.whole;
    }

    let table: string | undefined;
    if (format === 'sql' && dbType) {
      if (b) {
        table = `${quoteIdent(dbType, b.src.container)}.${quoteIdent(dbType, b.src.table)}`;
        if (dbType === 'sqlite') {
          table = quoteIdent(dbType, b.src.table);
        }
      } else {
        const name = await vscode.window.showInputBox({
          prompt: 'Nom de la table dans les instructions INSERT',
          value: 'resultat',
          validateInput: (v) => (v.trim() ? undefined : 'Nom obligatoire'),
        });
        if (!name) {
          return;
        }
        table = quoteIdent(dbType, name.trim());
      }
    }

    const defaultName = `${b ? b.src.table : 'resultat'}.${EXTENSIONS[format]}`;
    const uri = await vscode.window.showSaveDialog({
      filters: { [pickedFormat.label]: [EXTENSIONS[format]] },
      saveLabel: 'Exporter',
      defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(), defaultName)),
    });
    if (!uri) {
      return;
    }

    const setting = vscode.workspace.getConfiguration('dbExplorer').get<string>('csvSeparator', ',');
    const options: ExportOptions = {
      format,
      columns: last.columns.map((name) => ({
        name,
        type: b?.src.tableColumns.find((c) => c.name === name)?.type,
      })),
      csvSeparator: setting === 'tab' ? '\t' : setting,
      dbType,
      table,
    };

    try {
      if (!whole || !b) {
        const rows = last.rows.filter((r): r is Row => r !== null);
        const { text, lost } = await formatRows(options, rows);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
        this.exported(uri.fsPath, rows.length, lost);
        return;
      }
      await this.exportWholeTable(b, options, uri);
    } catch (err) {
      vscode.window.showErrorMessage(`Export impossible : ${errorMessage(err)}`);
    }
  }

  private async exportWholeTable(b: BrowseState, options: ExportOptions, uri: vscode.Uri): Promise<void> {
    const { src } = b;
    const driver = await src.getDriver();
    const maxRows = vscode.workspace.getConfiguration('dbExplorer').get<number>('maxRows', 5000);
    const batch = Math.max(1, Math.min(2000, maxRows - 1));

    // Fichier local : écriture en continu (mémoire bornée). Autre schéma (distant) : tout en mémoire.
    const chunks: string[] = [];
    let stream: fs.WriteStream | undefined;
    if (uri.scheme === 'file' || uri.scheme === undefined) {
      stream = fs.createWriteStream(uri.fsPath, { encoding: 'utf8' });
    }
    let streamError: Error | undefined;
    stream?.on('error', (e) => (streamError = e));
    const write = async (chunk: string): Promise<void> => {
      if (streamError) {
        throw streamError;
      }
      if (!stream) {
        chunks.push(chunk);
      } else if (!stream.write(chunk)) {
        await new Promise<void>((resolve) => stream!.once('drain', resolve));
      }
    };
    const formatter = new RowFormatter(options, write);

    let cancelled = false;
    let written = 0;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Export de ${src.table}`,
          cancellable: true,
        },
        async (progress, cancel) => {
          cancel.onCancellationRequested(() => (cancelled = true));
          await formatter.begin();
          let reported = 0;
          written = await streamTable({
            driver,
            query: {
              dbType: src.dbType,
              container: src.container,
              table: src.table,
              columns: src.tableColumns,
              sort: b.sort ? { column: src.tableColumns[b.sort.col].name, dir: b.sort.dir } : undefined,
              filter: b.filter,
              where: b.where ? { column: src.tableColumns[b.where.col].name, value: b.where.value } : undefined,
            },
            batch,
            isCancelled: () => cancelled,
            onBatch: (rows) => formatter.rows(rows),
            onProgress: (done, total) => {
              progress.report({
                message: total ? `${done} / ${total} lignes` : `${done} lignes`,
                increment: total ? ((done - reported) / total) * 100 : undefined,
              });
              reported = done;
            },
          });
          if (!cancelled) {
            await formatter.end();
          }
        },
      );
      if (stream) {
        await new Promise<void>((resolve, reject) => {
          stream!.once('error', reject);
          stream!.end(resolve);
        });
      } else if (!cancelled) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(chunks.join(''), 'utf8'));
      }
    } catch (err) {
      stream?.destroy();
      if (stream) {
        fs.rmSync(uri.fsPath, { force: true });
      }
      throw err;
    }
    if (cancelled) {
      if (stream) {
        fs.rmSync(uri.fsPath, { force: true });
      }
      vscode.window.showInformationMessage('Export annulé : le fichier partiel a été supprimé.');
      return;
    }
    this.exported(uri.fsPath, written, formatter.lost.n);
  }

  private exported(file: string, rows: number, lost: number): void {
    let msg = `Export enregistré : ${file} (${plural(rows, 'ligne', 'lignes')})`;
    if (lost > 0) {
      msg += ` — ${plural(lost, 'valeur binaire trop longue a été remplacée', 'valeurs binaires trop longues ont été remplacées')} par NULL.`;
    }
    void vscode.window.showInformationMessage(msg);
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
  where?: unknown;
  col?: unknown;
  index?: unknown;
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

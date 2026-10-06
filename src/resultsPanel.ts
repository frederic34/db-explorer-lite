import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { buildDeletes, buildSelectRow, buildUpdate, EditPlan, planEditing } from './editing';
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
}

/** Résultat lisible mais pas modifiable (vue, requête libre…) : on peut en donner la raison. */
export interface ReadOnlySpec {
  readOnlyReason: string;
}

interface EditInfo {
  table: string;
  pk: number[];
  editable: boolean[];
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
}

interface State {
  columns: string[];
  /** Lignes d'origine ; null = supprimée (les indices restent stables pour la page). */
  rows: (Row | null)[];
  spec?: EditSpec;
  plan?: EditPlan;
}

const CSS = `
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); background: var(--vscode-editor-background);
         margin: 0; padding: 10px 14px; }
  .muted { color: var(--vscode-descriptionForeground); }
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
  var summary = el('span', 'muted', ' · ' + data.summary);
  top.appendChild(summary);
  root.appendChild(top);

  var details = el('details', 'sql');
  details.appendChild(el('summary', '', 'Requête'));
  details.appendChild(el('pre', '', data.sql));
  root.appendChild(details);

  if (data.kind === 'error') {
    root.appendChild(el('pre', 'error', data.error));
    return;
  }
  if (data.columns.length === 0) { return; }

  var edit = data.edit || null;
  var rows = data.rows.map(function (c, i) { return { i: i, c: c }; });
  var sortCol = -1;
  var asc = true;
  var term = '';
  var selected = {};
  var editing = null;
  var busy = false;
  var deletedCount = 0;

  if (!edit && data.readOnlyReason) {
    root.appendChild(el('div', 'muted top', 'Lecture seule : ' + data.readOnlyReason + '.'));
  }

  var bar = el('div', 'bar');
  var filter = el('input');
  filter.type = 'search';
  filter.placeholder = 'Filtrer les lignes…';
  var info = el('span', 'muted');
  var spacer = el('span', 'spacer');
  var delBtn = null;
  if (edit) { delBtn = el('button', 'danger', 'Supprimer la sélection'); }
  var exportBtn = el('button', '', 'Exporter en CSV');
  exportBtn.addEventListener('click', function () { vscode.postMessage({ type: 'exportCsv', token: data.token }); });
  bar.appendChild(filter);
  bar.appendChild(info);
  bar.appendChild(spacer);
  if (delBtn) { bar.appendChild(delBtn); }
  bar.appendChild(exportBtn);
  root.appendChild(bar);

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
    if (!term) { return rows; }
    return rows.filter(function (r) {
      return r.c.some(function (c) { return c !== null && c.toLowerCase().indexOf(term) !== -1; });
    });
  }
  function selectedCount() { return Object.keys(selected).length; }

  function updateBar() {
    var vis = visibleRows();
    info.textContent = term ? vis.length + ' / ' + rows.length + ' lignes affichées' : '';
    if (edit) {
      var n = selectedCount();
      delBtn.textContent = n > 0 ? 'Supprimer la sélection (' + n + ')' : 'Supprimer la sélection';
      delBtn.disabled = busy || n === 0;
      var all = vis.length > 0 && vis.every(function (r) { return selected[r.i]; });
      selectAll.checked = all;
      selectAll.indeterminate = !all && vis.some(function (r) { return selected[r.i]; });
      selectAll.disabled = busy || vis.length === 0;
    }
    var extra = deletedCount > 0 ? ' · ' + plural(deletedCount, 'ligne supprimée', 'lignes supprimées') : '';
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
    for (var i = 0; i < list.length; i++) { frag.appendChild(renderRow(list[i], i + 1)); }
    tbody.replaceChildren(frag);
    updateBar();
  }

  filter.addEventListener('input', function () {
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

  window.addEventListener('message', function (event) {
    var m = event.data;
    if (!m || m.type !== 'opResult' || m.token !== data.token) { return; }
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
    }
    renderBody();
  });

  updateHeaders();
  renderBody();
})();
`;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

export class ResultsPanel {
  private panel?: vscode.WebviewPanel;
  private last?: State;
  private token = '';

  showResult(
    connection: string,
    sql: string,
    result: QueryResult,
    edit?: EditSpec | ReadOnlySpec,
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
    summary += ` · ${result.durationMs} ms`;

    const state: State = { columns: result.columns, rows: result.rows.map((r) => [...r]) };
    let editInfo: EditInfo | undefined;
    let readOnlyReason: string | undefined;
    if (edit && 'readOnlyReason' in edit) {
      readOnlyReason = edit.readOnlyReason;
    } else if (edit && result.columns.length > 0) {
      const planned = planEditing(edit.dbType, result.columns, edit.tableColumns);
      if ('plan' in planned) {
        state.spec = edit;
        state.plan = planned.plan;
        editInfo = {
          table: edit.table,
          pk: planned.plan.pk,
          editable: planned.plan.editable,
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
      connection,
      sql,
      columns: result.columns,
      rows: result.rows,
      summary,
      edit: editInfo,
      readOnlyReason,
    });
  }

  showError(connection: string, sql: string, message: string): void {
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

  private reply(message: Record<string, unknown>): void {
    void this.panel?.webview.postMessage({ type: 'opResult', token: this.token, ...message });
  }

  private async onMessage(msg: Message): Promise<void> {
    // Message venu d'une page déjà remplacée par un nouveau résultat : on l'ignore.
    if (!msg || msg.token !== this.token) {
      return;
    }
    switch (msg.type) {
      case 'exportCsv':
        await this.exportCsv();
        break;
      case 'updateRow':
        await this.updateRow(msg.rowIndex, msg.changes);
        break;
      case 'deleteRows':
        await this.deleteRows(msg.rowIndexes);
        break;
    }
  }

  private async updateRow(rowIndex: unknown, changes: unknown): Promise<void> {
    const fail = (message: string) => this.reply({ op: 'update', ok: false, message });
    const st = this.last;
    if (!st?.spec || !st.plan) {
      return fail("Modification impossible : ce résultat n'est pas modifiable.");
    }
    const row = typeof rowIndex === 'number' ? st.rows[rowIndex] : undefined;
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
      return this.reply({ op: 'update', ok: true, rowIndex, values: row });
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
      st.rows[rowIndex as number] = values;
      this.reply({ op: 'update', ok: true, rowIndex, values });
    } catch (err) {
      fail(errorMessage(err));
    }
  }

  private async deleteRows(rowIndexes: unknown): Promise<void> {
    const fail = (message: string) => this.reply({ op: 'delete', ok: false, message });
    const st = this.last;
    if (!st?.spec || !st.plan) {
      return fail("Suppression impossible : ce résultat n'est pas modifiable.");
    }
    if (!Array.isArray(rowIndexes)) {
      return fail('Sélection invalide.');
    }
    const { spec, plan } = st;
    const indexes = [...new Set(rowIndexes)].filter(
      (i): i is number => typeof i === 'number' && Number.isInteger(i) && !!st.rows[i],
    );
    if (indexes.length === 0) {
      return this.reply({ op: 'delete', ok: true, rowIndexes: [] });
    }

    const remove = 'Supprimer';
    const choice = await vscode.window.showWarningMessage(
      `Supprimer ${plural(indexes.length, 'ligne', 'lignes')} de « ${spec.table} » ?`,
      { modal: true, detail: 'Cette action est irréversible.' },
      remove,
    );
    if (choice !== remove) {
      return this.reply({ op: 'delete', ok: false, cancelled: true });
    }

    try {
      const driver = await spec.getDriver();
      const pkRows = indexes.map((i) => plan.pk.map((j) => (st.rows[i] as Row)[j]));
      await driver.executeBatch(
        buildDeletes(
          spec.dbType,
          spec.container,
          spec.table,
          plan.pk.map((j) => st.columns[j]),
          pkRows,
        ),
      );
      indexes.forEach((i) => (st.rows[i] = null));
      this.reply({ op: 'delete', ok: true, rowIndexes: indexes });
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

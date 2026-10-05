import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { QueryResult } from './types';

interface Payload {
  kind: 'result' | 'error';
  connection: string;
  sql: string;
  columns: string[];
  rows: (string | null)[][];
  summary: string;
  error?: string;
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
  .bar { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .bar input { flex: 0 1 280px; background: var(--vscode-input-background);
               color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
               padding: 3px 6px; }
  .bar button { margin-left: auto; background: var(--vscode-button-background);
                color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; }
  .bar button:hover { background: var(--vscode-button-hoverBackground); }
  .wrap { overflow: auto; max-height: calc(100vh - 150px); border: 1px solid var(--vscode-panel-border); }
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
  tbody tr:hover { background: var(--vscode-list-hoverBackground); }
`;

const SCRIPT = `
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

  var top = el('div', 'top');
  top.appendChild(el('strong', '', data.connection));
  top.appendChild(el('span', 'muted', ' \\u00b7 ' + data.summary));
  root.appendChild(top);

  var details = el('details', 'sql');
  details.appendChild(el('summary', '', 'Requ\\u00eate'));
  details.appendChild(el('pre', '', data.sql));
  root.appendChild(details);

  if (data.kind === 'error') {
    root.appendChild(el('pre', 'error', data.error));
    return;
  }
  if (data.columns.length === 0) { return; }

  var rows = data.rows.slice();
  var sortCol = -1;
  var asc = true;
  var term = '';

  var bar = el('div', 'bar');
  var filter = el('input');
  filter.type = 'search';
  filter.placeholder = 'Filtrer les lignes\\u2026';
  var info = el('span', 'muted');
  var exportBtn = el('button', '', 'Exporter en CSV');
  exportBtn.addEventListener('click', function () { vscode.postMessage({ type: 'exportCsv' }); });
  bar.appendChild(filter);
  bar.appendChild(info);
  bar.appendChild(exportBtn);
  root.appendChild(bar);

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
  hr.appendChild(el('th', 'rownum', '#'));
  var ths = data.columns.map(function (name, i) {
    var th = el('th', 'sortable', name);
    th.title = 'Trier par cette colonne';
    th.addEventListener('click', function () {
      if (sortCol === i) { asc = !asc; } else { sortCol = i; asc = true; }
      rows.sort(function (a, b) { return compare(a[i], b[i]) * (asc ? 1 : -1); });
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
      th.textContent = data.columns[i] + (sortCol === i ? (asc ? ' \\u25b2' : ' \\u25bc') : '');
    });
  }

  function renderBody() {
    var list = rows;
    if (term) {
      list = rows.filter(function (r) {
        return r.some(function (c) { return c !== null && c.toLowerCase().indexOf(term) !== -1; });
      });
    }
    var frag = document.createDocumentFragment();
    for (var i = 0; i < list.length; i++) {
      var tr = document.createElement('tr');
      tr.appendChild(el('td', 'rownum', String(i + 1)));
      for (var j = 0; j < list[i].length; j++) {
        var c = list[i][j];
        var td = c === null ? el('td', 'null', 'NULL') : el('td', '', c);
        if (c !== null && c.length > 60) { td.title = c.length > 1000 ? c.slice(0, 1000) + '\\u2026' : c; }
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }
    tbody.replaceChildren(frag);
    info.textContent = term ? list.length + ' / ' + rows.length + ' lignes affich\\u00e9es' : '';
  }

  filter.addEventListener('input', function () {
    term = filter.value.toLowerCase();
    renderBody();
  });

  renderBody();
})();
`;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

export class ResultsPanel {
  private panel?: vscode.WebviewPanel;
  private last?: { columns: string[]; rows: (string | null)[][] };

  showResult(connection: string, sql: string, result: QueryResult): void {
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

    this.last = { columns: result.columns, rows: result.rows };
    this.render({
      kind: 'result',
      connection,
      sql,
      columns: result.columns,
      rows: result.rows,
      summary,
    });
  }

  showError(connection: string, sql: string, message: string): void {
    this.last = undefined;
    this.render({
      kind: 'error',
      connection,
      sql,
      columns: [],
      rows: [],
      summary: 'erreur',
      error: message,
    });
  }

  private render(payload: Payload): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'dbExplorer.results',
        'Résultats SQL',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
      this.panel.webview.onDidReceiveMessage((msg: { type?: string }) => {
        if (msg?.type === 'exportCsv') {
          void this.exportCsv();
        }
      });
    } else {
      this.panel.reveal(undefined, true);
    }
    this.panel.webview.html = buildHtml(payload, randomBytes(16).toString('hex'));
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
    const lines = [this.last.columns, ...this.last.rows].map((r) => r.map(escape).join(sep));

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

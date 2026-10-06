import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { TableStructure } from './types';

export interface StructurePayload {
  title: string;
  connection: string;
  badges?: string[];
  structure: TableStructure;
}

const CSS = `
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 10px 16px 24px; }
  h1 { font-size: 1.25em; margin: 0 0 2px; }
  h2 { font-size: 1.05em; margin: 18px 0 6px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .badge { display: inline-block; margin-left: 8px; padding: 0 7px; border-radius: 3px; font-size: 0.8em; font-weight: 600;
           border: 1px solid var(--vscode-descriptionForeground); color: var(--vscode-descriptionForeground); }
  .badge.prod { background: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
  table { border-collapse: collapse; min-width: 50%; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  th, td { padding: 3px 12px 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; }
  td.def, td.com { white-space: pre-wrap; word-break: break-word; max-width: 420px; }
  .yes { color: var(--vscode-testing-iconPassed, #3fb950); }
  pre { font-family: var(--vscode-editor-font-family); margin: 6px 0; white-space: pre-wrap; word-break: break-word;
        background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; }
  .bar { display: flex; gap: 8px; align-items: center; margin-top: 18px; }
  button { font: inherit; border: none; border-radius: 2px; cursor: pointer; padding: 4px 10px;
           background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  #done { color: var(--vscode-testing-iconPassed, #3fb950); }
`;

const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  var data = JSON.parse(document.getElementById('data').textContent);
  var root = document.getElementById('root');
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text !== undefined) { e.textContent = text; } return e; }
  function table(heads, rows, classes) {
    var t = el('table'), thead = el('thead'), hr = el('tr');
    heads.forEach(function (h) { hr.appendChild(el('th', '', h)); });
    thead.appendChild(hr); t.appendChild(thead);
    var tb = el('tbody');
    rows.forEach(function (r) {
      var tr = el('tr');
      r.forEach(function (c, i) {
        var td = el('td', (classes && classes[i]) || '');
        if (c === null) { td.appendChild(el('span', 'muted', '—')); }
        else if (c === true) { td.appendChild(el('span', 'yes', '✓')); }
        else if (c === false) { td.textContent = ''; }
        else { td.textContent = String(c); }
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    return t;
  }

  var h = el('h1', '', data.title);
  (data.badges || []).forEach(function (b) { h.appendChild(el('span', 'badge' + (b === 'PRODUCTION' ? ' prod' : ''), b)); });
  root.appendChild(h);
  var s = data.structure;
  root.appendChild(el('div', 'muted', data.connection + (s.isView ? ' · vue' : ' · table')));

  root.appendChild(el('h2', '', 'Colonnes (' + s.columns.length + ')'));
  var hasComment = s.columns.some(function (c) { return c.comment; });
  var heads = ['#', 'Nom', 'Type', 'Clé primaire', 'Obligatoire', 'Défaut', 'Particularité'];
  if (hasComment) { heads.push('Commentaire'); }
  root.appendChild(table(heads, s.columns.map(function (c, i) {
    var r = [i + 1, c.name, c.type, c.primaryKey, !c.nullable, c.default, c.extra || null];
    if (hasComment) { r.push(c.comment || null); }
    return r;
  }), ['', '', '', '', '', 'def', '', 'com']));

  root.appendChild(el('h2', '', 'Index (' + s.indexes.length + ')'));
  if (s.indexes.length === 0) { root.appendChild(el('div', 'muted', 'Aucun index.')); }
  else {
    root.appendChild(table(['Nom', 'Colonnes', 'Unique', 'Clé primaire', 'Type'], s.indexes.map(function (x) {
      return [x.name, x.columns.join(', '), x.unique, x.primary, x.method || null];
    })));
  }

  root.appendChild(el('h2', '', 'Contraintes (' + s.constraints.length + ')'));
  if (s.constraints.length === 0) { root.appendChild(el('div', 'muted', 'Aucune contrainte.')); }
  else {
    root.appendChild(table(['Nom', 'Type', 'Définition'], s.constraints.map(function (k) { return [k.name, k.kind, k.definition]; }), ['', '', 'def']));
  }

  root.appendChild(el('h2', '', 'DDL'));
  root.appendChild(el('pre', '', s.ddl));
  var bar = el('div', 'bar');
  var copy = el('button', '', 'Copier le DDL');
  var open = el('button', '', 'Ouvrir dans un éditeur SQL');
  var done = el('span', '');
  done.id = 'done';
  copy.addEventListener('click', function () { vscode.postMessage({ type: 'copy' }); done.textContent = 'Copié.'; setTimeout(function () { done.textContent = ''; }, 2000); });
  open.addEventListener('click', function () { vscode.postMessage({ type: 'openSql' }); });
  bar.appendChild(copy); bar.appendChild(open); bar.appendChild(done);
  root.appendChild(bar);
})();
`;

export function buildStructureHtml(payload: StructurePayload, nonce: string): string {
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Structure</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<div id="root"></div>
<script id="data" type="application/json" nonce="${nonce}">${data}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

/** Un panneau par table : rouvrir la même table rafraîchit le panneau existant. */
export class StructurePanels {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  show(key: string, payload: StructurePayload): void {
    let panel = this.panels.get(key);
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        'dbExplorer.structure',
        `Structure · ${payload.title}`,
        { viewColumn: vscode.ViewColumn.Active },
        { enableScripts: true },
      );
      this.panels.set(key, panel);
      panel.onDidDispose(() => this.panels.delete(key));
      panel.webview.onDidReceiveMessage(async (msg: { type?: string }) => {
        const ddl = this.ddl.get(key);
        if (ddl === undefined) {
          return;
        }
        if (msg?.type === 'copy') {
          await vscode.env.clipboard.writeText(ddl);
        } else if (msg?.type === 'openSql') {
          const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: ddl });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        }
      });
    } else {
      panel.title = `Structure · ${payload.title}`;
      panel.reveal();
    }
    this.ddl.set(key, payload.structure.ddl);
    panel.webview.html = buildStructureHtml(payload, randomBytes(16).toString('hex'));
  }

  private readonly ddl = new Map<string, string>();
}

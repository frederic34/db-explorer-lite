import { randomBytes, randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { ConnectionConfig, DbType } from './types';
import { errorMessage } from './util';

interface FormValues {
  type: DbType;
  name: string;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
}

interface InitData {
  editing: boolean;
  values: Omit<FormValues, 'password'>;
}

const openForms = new Map<string, vscode.WebviewPanel>();

/** Ouvre le formulaire de création (existing absent) ou de modification d'une connexion. */
export function openConnectionForm(manager: ConnectionManager, existing?: ConnectionConfig): void {
  const key = existing?.id ?? 'new';
  const already = openForms.get(key);
  if (already) {
    already.reveal();
    return;
  }

  const editing = existing !== undefined;
  const panel = vscode.window.createWebviewPanel(
    'dbExplorer.connectionForm',
    editing ? `Connexion : ${existing.name}` : 'Nouvelle connexion',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  openForms.set(key, panel);
  panel.onDidDispose(() => openForms.delete(key));

  const type: DbType = existing?.type ?? 'mysql';
  const init: InitData = {
    editing,
    values: {
      type,
      name: existing?.name ?? '',
      host: existing?.host ?? 'localhost',
      port: String(existing?.port ?? defaultPort(type)),
      user: existing?.user ?? defaultUser(type),
      database: existing?.database ?? (type === 'postgres' ? 'postgres' : ''),
      ssl: existing?.ssl ?? false,
    },
  };
  panel.webview.html = buildHtml(init, randomBytes(16).toString('hex'));

  /** Valide les champs ; retourne un message d'erreur, ou la configuration prête à l'emploi. */
  const toConfig = (v: FormValues): { error: string } | { config: ConnectionConfig } => {
    const port = Number(v.port);
    if (!v.host.trim()) {
      return { error: "L'hôte est obligatoire." };
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: 'Le port doit être un entier entre 1 et 65535.' };
    }
    if (!v.user.trim()) {
      return { error: "Le nom d'utilisateur est obligatoire." };
    }
    if (v.type === 'postgres' && !v.database.trim()) {
      return { error: 'La base de données est obligatoire pour PostgreSQL.' };
    }
    const database = v.database.trim() || undefined;
    return {
      config: {
        id: existing?.id ?? randomUUID(),
        name: v.name.trim() || `${v.user.trim()}@${v.host.trim()}${database ? '/' + database : ''}`,
        type: v.type === 'postgres' ? 'postgres' : 'mysql',
        host: v.host.trim(),
        port,
        user: v.user.trim(),
        database,
        ssl: v.ssl === true,
      },
    };
  };

  /** Mot de passe saisi, ou conservé (modification avec champ vide). */
  const effectivePassword = async (v: FormValues): Promise<string> =>
    v.password === '' && existing ? ((await manager.getPassword(existing.id)) ?? '') : v.password;

  panel.webview.onDidReceiveMessage(async (msg: { type?: string; values?: FormValues }) => {
    if (msg?.type === 'cancel') {
      panel.dispose();
      return;
    }
    if (!msg?.values || (msg.type !== 'test' && msg.type !== 'save')) {
      return;
    }
    const checked = toConfig(msg.values);
    if ('error' in checked) {
      void panel.webview.postMessage({ type: 'result', action: msg.type, ok: false, message: checked.error });
      return;
    }

    if (msg.type === 'test') {
      try {
        await manager.test(checked.config, await effectivePassword(msg.values));
        void panel.webview.postMessage({
          type: 'result',
          action: 'test',
          ok: true,
          message: 'Connexion réussie.',
        });
      } catch (err) {
        void panel.webview.postMessage({
          type: 'result',
          action: 'test',
          ok: false,
          message: errorMessage(err),
        });
      }
      return;
    }

    try {
      // Modification avec mot de passe vide : on garde l'ancien (undefined = inchangé).
      const password = editing && msg.values.password === '' ? undefined : msg.values.password;
      await manager.save(checked.config, password);
      panel.dispose();
    } catch (err) {
      void panel.webview.postMessage({
        type: 'result',
        action: 'save',
        ok: false,
        message: `Enregistrement impossible : ${errorMessage(err)}`,
      });
    }
  });
}

function defaultPort(type: DbType): number {
  return type === 'mysql' ? 3306 : 5432;
}

function defaultUser(type: DbType): string {
  return type === 'mysql' ? 'root' : 'postgres';
}

const CSS = `
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); background: var(--vscode-editor-background);
         margin: 0; padding: 24px 28px; }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.5em; font-weight: 600; margin: 0 0 4px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .lead { margin: 0 0 20px; }
  fieldset { border: none; padding: 0; margin: 0 0 18px; }
  legend, label.field { display: block; font-weight: 600; margin-bottom: 4px; }
  .hint { font-size: 0.9em; color: var(--vscode-descriptionForeground); margin-top: 3px; }
  .types { display: flex; gap: 10px; }
  .types label { flex: 1; display: flex; align-items: center; gap: 8px; cursor: pointer;
                 padding: 10px 12px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  .types label:hover { background: var(--vscode-list-hoverBackground); }
  .types label:has(input:checked) { border-color: var(--vscode-focusBorder);
                 background: var(--vscode-list-inactiveSelectionBackground); }
  .row { display: flex; gap: 12px; }
  .row > div { flex: 1; }
  .row > div.narrow { flex: 0 0 110px; }
  input[type=text], input[type=number], input[type=password], input[type=url] {
    width: 100%; box-sizing: border-box; padding: 5px 8px; font: inherit;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; }
  input:focus-visible, button:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  input.invalid { border-color: var(--vscode-inputValidation-errorBorder); }
  .err { color: var(--vscode-errorForeground); font-size: 0.9em; margin-top: 3px; min-height: 1em; }
  .pwd { display: flex; gap: 6px; }
  .check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  details { margin: 0 0 18px; }
  summary { cursor: pointer; font-weight: 600; margin-bottom: 8px; }
  .actions { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
  button { font: inherit; padding: 6px 14px; border: none; border-radius: 2px; cursor: pointer;
           background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.55; cursor: default; }
  .spacer { flex: 1; }
  #status { margin-top: 14px; padding: 8px 12px; border-radius: 3px; display: none; white-space: pre-wrap;
            border-left: 3px solid; word-break: break-word; }
  #status.ok { display: block; border-color: var(--vscode-testing-iconPassed, #3fb950);
               background: var(--vscode-textBlockQuote-background); }
  #status.ko { display: block; border-color: var(--vscode-errorForeground);
               background: var(--vscode-textBlockQuote-background); color: var(--vscode-errorForeground); }
  #status.busy { display: block; border-color: var(--vscode-focusBorder);
                 background: var(--vscode-textBlockQuote-background); }
`;

const SCRIPT = String.raw`
(function () {
  var vscode = acquireVsCodeApi();
  var init = JSON.parse(document.getElementById('init').textContent);
  var $ = function (id) { return document.getElementById(id); };

  var DEFAULT_PORT = { mysql: '3306', postgres: '5432' };
  var DEFAULT_USER = { mysql: 'root', postgres: 'postgres' };
  var touched = { port: init.editing, user: init.editing, name: init.editing, database: init.editing };

  var form = $('form'), status = $('status');
  var fields = { name: $('name'), host: $('host'), port: $('port'), user: $('user'),
                 password: $('password'), database: $('database') };

  function currentType() { return form.elements['type'].value; }

  // --- Valeurs initiales -----------------------------------------------------------------
  var v = init.values;
  form.elements['type'].value = v.type;
  Object.keys(fields).forEach(function (k) { if (k !== 'password') { fields[k].value = v[k] || ''; } });
  $('ssl').checked = !!v.ssl;
  if (init.editing) {
    $('title').textContent = 'Modifier la connexion';
    fields.password.placeholder = 'Laisser vide pour conserver le mot de passe actuel';
  }

  ['port', 'user', 'name', 'database'].forEach(function (k) {
    fields[k].addEventListener('input', function () { touched[k] = true; });
  });

  function suggestName() {
    if (touched.name) { return; }
    var h = fields.host.value.trim(), u = fields.user.value.trim(), d = fields.database.value.trim();
    fields.name.value = h ? ((u ? u + '@' : '') + h + (d ? '/' + d : '')) : '';
  }
  ['host', 'user', 'database'].forEach(function (k) { fields[k].addEventListener('input', suggestName); });
  suggestName();

  function applyType() {
    var t = currentType();
    if (!touched.port) { fields.port.value = DEFAULT_PORT[t]; }
    if (!touched.user) { fields.user.value = DEFAULT_USER[t]; }
    if (!touched.database) { fields.database.value = t === 'postgres' ? 'postgres' : ''; }
    $('dbhint').textContent = t === 'mysql'
      ? 'Optionnel : laissez vide pour lister toutes les bases du serveur.'
      : 'Obligatoire : les schémas de cette base seront listés.';
    suggestName();
    clearStatus();
  }
  Array.prototype.forEach.call(form.elements['type'], function (r) { r.addEventListener('change', applyType); });
  applyType();

  // --- Import depuis une URL de connexion ------------------------------------------------
  $('importBtn').addEventListener('click', function () {
    var raw = $('url').value.trim();
    var msg = $('urlerr');
    msg.textContent = '';
    if (!raw) { return; }
    var u;
    try { u = new URL(raw); } catch (e) { msg.textContent = 'URL invalide.'; return; }
    var proto = u.protocol.replace(':', '').toLowerCase();
    var t = proto === 'mysql' || proto === 'mariadb' ? 'mysql'
          : proto === 'postgres' || proto === 'postgresql' ? 'postgres' : '';
    if (!t) { msg.textContent = 'Protocole non pris en charge (mysql://, mariadb://, postgres://, postgresql://).'; return; }
    function dec(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
    form.elements['type'].value = t;
    fields.host.value = dec(u.hostname.replace(/^\[|\]$/g, ''));
    fields.port.value = u.port || DEFAULT_PORT[t];
    fields.user.value = dec(u.username);
    if (u.password) { fields.password.value = dec(u.password); }
    fields.database.value = dec(u.pathname.replace(/^\//, ''));
    var ssl = u.searchParams.get('ssl') || u.searchParams.get('sslmode') || u.searchParams.get('tls');
    $('ssl').checked = !!ssl && ['0', 'false', 'disable', 'off'].indexOf(ssl.toLowerCase()) === -1;
    touched.port = touched.user = touched.database = true;
    touched.name = false;
    $('url').value = '';
    $('dbhint').textContent = t === 'mysql'
      ? 'Optionnel : laissez vide pour lister toutes les bases du serveur.'
      : 'Obligatoire : les schémas de cette base seront listés.';
    suggestName();
    clearStatus();
    validate(false);
  });
  $('url').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('importBtn').click(); }
  });

  // --- Mot de passe visible / masqué -----------------------------------------------------
  $('toggle').addEventListener('click', function () {
    var show = fields.password.type === 'password';
    fields.password.type = show ? 'text' : 'password';
    this.textContent = show ? 'Masquer' : 'Afficher';
  });

  // --- Validation ------------------------------------------------------------------------
  function setErr(key, text) {
    var input = fields[key];
    $('err-' + key).textContent = text || '';
    input.classList.toggle('invalid', !!text);
    if (text) { input.setAttribute('aria-invalid', 'true'); } else { input.removeAttribute('aria-invalid'); }
  }

  function validate(focusFirst) {
    var errors = [];
    var port = Number(fields.port.value);
    var checks = [
      ['host', !fields.host.value.trim() ? "L'hôte est obligatoire." : ''],
      ['port', !(fields.port.value.trim() !== '' && Number.isInteger(port) && port >= 1 && port <= 65535) ? 'Port entre 1 et 65535.' : ''],
      ['user', !fields.user.value.trim() ? "Le nom d'utilisateur est obligatoire." : ''],
      ['database', currentType() === 'postgres' && !fields.database.value.trim() ? 'Obligatoire pour PostgreSQL.' : '']
    ];
    checks.forEach(function (c) { setErr(c[0], c[1]); if (c[1]) { errors.push(c[0]); } });
    if (focusFirst && errors.length) { fields[errors[0]].focus(); }
    return errors.length === 0;
  }
  ['host', 'port', 'user', 'database'].forEach(function (k) {
    fields[k].addEventListener('blur', function () { validate(false); });
  });

  // --- Actions ---------------------------------------------------------------------------
  function values() {
    return {
      type: currentType(), name: fields.name.value, host: fields.host.value, port: fields.port.value,
      user: fields.user.value, password: fields.password.value, database: fields.database.value,
      ssl: $('ssl').checked
    };
  }
  function setBusy(busy) { $('testBtn').disabled = busy; $('saveBtn').disabled = busy; }
  function clearStatus() { status.className = ''; status.textContent = ''; }
  function show(kind, text) { status.className = kind; status.textContent = text; }

  $('testBtn').addEventListener('click', function () {
    if (!validate(true)) { return; }
    setBusy(true);
    show('busy', 'Test de la connexion…');
    vscode.postMessage({ type: 'test', values: values() });
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!validate(true)) { return; }
    setBusy(true);
    show('busy', 'Enregistrement…');
    vscode.postMessage({ type: 'save', values: values() });
  });
  $('cancelBtn').addEventListener('click', function () { vscode.postMessage({ type: 'cancel' }); });

  window.addEventListener('message', function (event) {
    var m = event.data;
    if (!m || m.type !== 'result') { return; }
    setBusy(false);
    show(m.ok ? 'ok' : 'ko', (m.ok ? '✓ ' : '✗ ') + m.message);
  });

  fields.host.focus();
})();
`;

function buildHtml(init: InitData, nonce: string): string {
  const data = JSON.stringify(init).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connexion</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<main>
  <h1 id="title">Nouvelle connexion</h1>
  <p class="lead muted">Renseignez le serveur, testez la connexion, puis enregistrez.</p>

  <form id="form" novalidate autocomplete="off">
    <fieldset>
      <legend>Type de base de données</legend>
      <div class="types">
        <label><input type="radio" name="type" value="mysql"> MySQL / MariaDB</label>
        <label><input type="radio" name="type" value="postgres"> PostgreSQL</label>
      </div>
    </fieldset>

    <details>
      <summary>Importer depuis une URL de connexion</summary>
      <div class="pwd">
        <input type="url" id="url" placeholder="mysql://utilisateur:motdepasse@hote:3306/base" aria-label="URL de connexion" autocomplete="off" spellcheck="false">
        <button type="button" id="importBtn">Importer</button>
      </div>
      <div class="err" id="urlerr" role="alert"></div>
      <div class="hint">Formats acceptés : mysql://, mariadb://, postgres://, postgresql://. Les champs ci-dessous sont remplis automatiquement.</div>
    </details>

    <div class="row">
      <div>
        <label class="field" for="host">Hôte</label>
        <input type="text" id="host" spellcheck="false" autocomplete="off">
        <div class="err" id="err-host" role="alert"></div>
      </div>
      <div class="narrow">
        <label class="field" for="port">Port</label>
        <input type="number" id="port" min="1" max="65535">
        <div class="err" id="err-port" role="alert"></div>
      </div>
    </div>

    <div class="row">
      <div>
        <label class="field" for="user">Utilisateur</label>
        <input type="text" id="user" spellcheck="false" autocomplete="off">
        <div class="err" id="err-user" role="alert"></div>
      </div>
      <div>
        <label class="field" for="password">Mot de passe</label>
        <div class="pwd">
          <input type="password" id="password" autocomplete="new-password">
          <button type="button" id="toggle" aria-label="Afficher ou masquer le mot de passe">Afficher</button>
        </div>
        <div class="err" id="err-password"></div>
      </div>
    </div>

    <div>
      <label class="field" for="database">Base de données</label>
      <input type="text" id="database" spellcheck="false" autocomplete="off">
      <div class="hint" id="dbhint"></div>
      <div class="err" id="err-database" role="alert"></div>
    </div>

    <fieldset>
      <label class="check"><input type="checkbox" id="ssl"> Chiffrer la connexion (SSL/TLS)</label>
    </fieldset>

    <div>
      <label class="field" for="name">Nom affiché</label>
      <input type="text" id="name" autocomplete="off">
      <div class="hint">Généré automatiquement à partir de l'utilisateur, de l'hôte et de la base si vous ne le modifiez pas.</div>
      <div class="err" id="err-name"></div>
    </div>

    <div class="actions">
      <button type="button" id="testBtn">Tester la connexion</button>
      <span class="spacer"></span>
      <button type="button" id="cancelBtn">Annuler</button>
      <button type="submit" id="saveBtn" class="primary">Enregistrer</button>
    </div>
    <div id="status" role="status" aria-live="polite"></div>
  </form>
</main>
<script id="init" type="application/json" nonce="${nonce}">${data}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

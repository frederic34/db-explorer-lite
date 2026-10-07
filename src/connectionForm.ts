import { isFrench, t, webviewI18n } from './i18n';
import { randomBytes, randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import * as os from 'os';
import * as path from 'path';
import { ConnectionConfig, DbType, SshConfig } from './types';
import { errorMessage } from './util';

interface FormValues {
  type: DbType;
  name: string;
  group: string;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  /** SQLite : chemin du fichier. */
  file: string;
  ssl: boolean;
  readOnly: boolean;
  production: boolean;
  sshOn: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshAuth: 'password' | 'key' | 'agent';
  /** Mot de passe SSH, ou phrase secrète de la clé. */
  sshSecret: string;
  sshKey: string;
}

interface InitData {
  editing: boolean;
  /** Groupes existants (suggestions du champ « Groupe »). */
  groups: string[];
  values: Omit<FormValues, 'password' | 'sshSecret'>;
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
    editing ? t(`Connexion : ${existing.name}`, `Connection: ${existing.name}`) : t('Nouvelle connexion', 'New connection'),
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  openForms.set(key, panel);
  panel.onDidDispose(() => openForms.delete(key));

  const type: DbType = existing?.type ?? 'mysql';
  const init: InitData = {
    editing,
    groups: manager.groups(),
    values: {
      type,
      name: existing?.name ?? '',
      group: existing?.group ?? '',
      host: existing?.host ?? 'localhost',
      port: String(existing?.port ?? defaultPort(type)),
      user: existing?.user ?? defaultUser(type),
      database: existing?.database ?? (type === 'postgres' ? 'postgres' : ''),
      file: existing?.file ?? '',
      ssl: existing?.ssl ?? false,
      readOnly: existing?.readOnly ?? false,
      production: existing?.production ?? false,
      sshOn: existing?.ssh !== undefined,
      sshHost: existing?.ssh?.host ?? '',
      sshPort: String(existing?.ssh?.port ?? 22),
      sshUser: existing?.ssh?.user ?? '',
      sshAuth: existing?.ssh?.authMethod ?? 'password',
      sshKey: existing?.ssh?.keyPath ?? '',
    },
  };
  panel.webview.html = buildHtml(init, randomBytes(16).toString('hex'));

  /** Valide les champs ; retourne un message d'erreur, ou la configuration prête à l'emploi. */
  const toConfig = (v: FormValues): { error: string } | { config: ConnectionConfig } => {
    if (v.type === 'sqlite') {
      const file = v.file.trim();
      if (!file) {
        return { error: t('Indiquez le fichier de la base SQLite.', 'Specify the SQLite database file.') };
      }
      return {
        config: {
          id: existing?.id ?? randomUUID(),
          name: v.name.trim() || path.basename(file),
          type: 'sqlite',
          host: '',
          port: 0,
          user: '',
          file,
          readOnly: true,
          group: v.group.trim() || undefined,
        },
      };
    }
    const port = Number(v.port);
    if (!v.host.trim()) {
      return { error: t("L'hôte est obligatoire.", 'Host is required.') };
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { error: t('Le port doit être un entier entre 1 et 65535.', 'Port must be an integer between 1 and 65535.') };
    }
    if (!v.user.trim()) {
      return { error: t("Le nom d'utilisateur est obligatoire.", 'User name is required.') };
    }
    if (v.type === 'postgres' && !v.database.trim()) {
      return { error: t('La base de données est obligatoire pour PostgreSQL.', 'The database is required for PostgreSQL.') };
    }
    let ssh: SshConfig | undefined;
    if (v.sshOn) {
      const sshPort = Number(v.sshPort);
      if (!v.sshHost.trim()) {
        return { error: t("L'hôte SSH est obligatoire.", 'SSH host is required.') };
      }
      if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
        return { error: t('Le port SSH doit être un entier entre 1 et 65535.', 'SSH port must be an integer between 1 and 65535.') };
      }
      if (!v.sshUser.trim()) {
        return { error: t("L'utilisateur SSH est obligatoire.", 'SSH user is required.') };
      }
      const authMethod = v.sshAuth === 'key' || v.sshAuth === 'agent' ? v.sshAuth : 'password';
      if (authMethod === 'key' && !v.sshKey.trim()) {
        return { error: t('Indiquez le fichier de clé privée SSH.', 'Specify the SSH private key file.') };
      }
      ssh = {
        host: v.sshHost.trim(),
        port: sshPort,
        user: v.sshUser.trim(),
        authMethod,
        keyPath: authMethod === 'key' ? v.sshKey.trim() : undefined,
      };
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
        group: v.group.trim() || undefined,
        readOnly: v.readOnly === true || undefined,
        production: v.production === true || undefined,
        ssh,
      },
    };
  };

  /** Mot de passe saisi, ou conservé (modification avec champ vide). */
  const effectivePassword = async (v: FormValues): Promise<string> =>
    v.password === '' && existing ? ((await manager.getPassword(existing.id)) ?? '') : v.password;
  const effectiveSshSecret = async (v: FormValues): Promise<string> =>
    v.sshSecret === '' && existing ? ((await manager.getSshSecret(existing.id)) ?? '') : v.sshSecret;

  panel.webview.onDidReceiveMessage(async (msg: { type?: string; values?: FormValues }) => {
    if (msg?.type === 'cancel') {
      panel.dispose();
      return;
    }
    if (msg?.type === 'pickFile') {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        title: t('Base SQLite', 'SQLite database'),
        openLabel: t('Choisir', 'Select'),
        filters: { [t('Bases SQLite', 'SQLite databases')]: ['db', 'sqlite', 'sqlite3', 'db3', 's3db'], [t('Tous les fichiers', 'All files')]: ['*'] },
      });
      if (picked?.[0]) {
        void panel.webview.postMessage({ type: 'filePicked', path: picked[0].fsPath });
      }
      return;
    }
    if (msg?.type === 'pickKey') {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        title: t('Clé privée SSH', 'SSH private key'),
        openLabel: t('Choisir', 'Select'),
        defaultUri: vscode.Uri.file(path.join(os.homedir(), '.ssh')),
      });
      if (picked?.[0]) {
        void panel.webview.postMessage({ type: 'keyPicked', path: picked[0].fsPath });
      }
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
        await manager.test(checked.config, await effectivePassword(msg.values), await effectiveSshSecret(msg.values));
        void panel.webview.postMessage({
          type: 'result',
          action: 'test',
          ok: true,
          message: t('Connexion réussie.', 'Connection successful.'),
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
      const sshSecret = editing && msg.values.sshSecret === '' ? undefined : msg.values.sshSecret;
      await manager.save(checked.config, password, sshSecret);
      panel.dispose();
    } catch (err) {
      void panel.webview.postMessage({
        type: 'result',
        action: 'save',
        ok: false,
        message: t(`Enregistrement impossible : ${errorMessage(err)}`, `Unable to save: ${errorMessage(err)}`),
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
  [hidden] { display: none !important; }
  select { width: 100%; box-sizing: border-box; padding: 5px 8px; font: inherit;
           background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
           border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 2px; }
  #sshBox { margin-top: 10px; padding-left: 12px; border-left: 2px solid var(--vscode-panel-border); }
  #sshBox .row, #sshBox > div { margin-bottom: 10px; }
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
  (init.groups || []).forEach(function (g) { var o = document.createElement('option'); o.value = g; $('groupList').appendChild(o); });
  var fields = { name: $('name'), group: $('group'), host: $('host'), port: $('port'), user: $('user'),
                 password: $('password'), database: $('database'),
                 sshHost: $('sshHost'), sshPort: $('sshPort'), sshUser: $('sshUser'), sshKey: $('sshKey'), file: $('file') };

  function currentType() { return form.elements['type'].value; }

  // --- Valeurs initiales -----------------------------------------------------------------
  var v = init.values;
  form.elements['type'].value = v.type;
  Object.keys(fields).forEach(function (k) { if (k !== 'password') { fields[k].value = v[k] || ''; } });
  $('ssl').checked = !!v.ssl;
  $('readOnly').checked = !!v.readOnly;
  $('production').checked = !!v.production;
  $('sshOn').checked = !!v.sshOn;
  $('sshHost').value = v.sshHost; $('sshPort').value = v.sshPort; $('sshUser').value = v.sshUser;
  $('sshAuth').value = v.sshAuth; $('sshKey').value = v.sshKey;
  function applySsh() {
    var on = $('sshOn').checked, auth = $('sshAuth').value;
    $('sshBox').hidden = !on;
    $('sshKeyRow').hidden = auth !== 'key';
    $('sshPwRow').hidden = auth === 'agent';
    $('sshSecretLabel').textContent = auth === 'key' ? T('Phrase secrète de la clé (si elle en a une)', 'Key passphrase (if it has one)') : T('Mot de passe SSH', 'SSH password');
    clearStatus();
  }
  $('sshOn').addEventListener('change', applySsh);
  $('sshAuth').addEventListener('change', applySsh);
  $('pickFile').addEventListener('click', function () { vscode.postMessage({ type: 'pickFile' }); });
  $('pickKey').addEventListener('click', function () { vscode.postMessage({ type: 'pickKey' }); });
  if (init.editing && v.sshOn) { $('sshSecret').placeholder = T('Laisser vide pour conserver le secret actuel', 'Leave empty to keep the current secret'); }
  if (init.editing) {
    $('title').textContent = T('Modifier la connexion', 'Edit connection');
    fields.password.placeholder = T('Laisser vide pour conserver le mot de passe actuel', 'Leave empty to keep the current password');
  }

  ['port', 'user', 'name', 'database'].forEach(function (k) {
    fields[k].addEventListener('input', function () { touched[k] = true; });
  });

  function suggestName() {
    if (touched.name) { return; }
    if (currentType() === 'sqlite') {
      var f = fields.file.value.trim().replace(/[\\/]+$/, '');
      fields.name.value = f ? f.split(/[\\/]/).pop() : '';
      return;
    }
    var h = fields.host.value.trim(), u = fields.user.value.trim(), d = fields.database.value.trim();
    fields.name.value = h ? ((u ? u + '@' : '') + h + (d ? '/' + d : '')) : '';
  }
  ['host', 'user', 'database', 'file'].forEach(function (k) { fields[k].addEventListener('input', suggestName); });
  suggestName();

  function applyType() {
    var t = currentType();
    var lite = t === 'sqlite';
    $('fileBox').hidden = !lite;
    $('serverBox').hidden = lite;
    $('secBox').hidden = lite;
    if (lite) { suggestName(); clearStatus(); return; }
    if (!touched.port) { fields.port.value = DEFAULT_PORT[t]; }
    if (!touched.user) { fields.user.value = DEFAULT_USER[t]; }
    if (!touched.database) { fields.database.value = t === 'postgres' ? 'postgres' : ''; }
    $('dbhint').textContent = t === 'mysql'
      ? T('Optionnel : laissez vide pour lister toutes les bases du serveur.', 'Optional: leave empty to list all databases on the server.')
      : T('Obligatoire : les schémas de cette base seront listés.', 'Required: the schemas of this database will be listed.');
    suggestName();
    clearStatus();
  }
  Array.prototype.forEach.call(form.elements['type'], function (r) { r.addEventListener('change', applyType); });
  applyType();
  applySsh();

  // --- Import depuis une URL de connexion ------------------------------------------------
  $('importBtn').addEventListener('click', function () {
    var raw = $('url').value.trim();
    var msg = $('urlerr');
    msg.textContent = '';
    if (!raw) { return; }
    var u;
    try { u = new URL(raw); } catch (e) { msg.textContent = T('URL invalide.', 'Invalid URL.'); return; }
    var proto = u.protocol.replace(':', '').toLowerCase();
    var t = proto === 'mysql' || proto === 'mariadb' ? 'mysql'
          : proto === 'postgres' || proto === 'postgresql' ? 'postgres' : '';
    if (!t) { msg.textContent = T('Protocole non pris en charge (mysql://, mariadb://, postgres://, postgresql://).', 'Unsupported protocol (mysql://, mariadb://, postgres://, postgresql://).'); return; }
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
      ? T('Optionnel : laissez vide pour lister toutes les bases du serveur.', 'Optional: leave empty to list all databases on the server.')
      : T('Obligatoire : les schémas de cette base seront listés.', 'Required: the schemas of this database will be listed.');
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
    this.textContent = show ? T('Masquer', 'Hide') : T('Afficher', 'Show');
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
    if (currentType() === 'sqlite') {
      var msg = !fields.file.value.trim() ? T('Indiquez le fichier de la base SQLite.', 'Specify the SQLite database file.') : '';
      setErr('file', msg);
      if (msg && focusFirst) { fields.file.focus(); }
      return !msg;
    }
    setErr('file', '');
    var port = Number(fields.port.value);
    var checks = [
      ['host', !fields.host.value.trim() ? T("L'hôte est obligatoire.", 'Host is required.') : ''],
      ['port', !(fields.port.value.trim() !== '' && Number.isInteger(port) && port >= 1 && port <= 65535) ? T('Port entre 1 et 65535.', 'Port between 1 and 65535.') : ''],
      ['user', !fields.user.value.trim() ? T("Le nom d'utilisateur est obligatoire.", 'User name is required.') : ''],
      ['database', currentType() === 'postgres' && !fields.database.value.trim() ? T('Obligatoire pour PostgreSQL.', 'Required for PostgreSQL.') : '']
    ];
    if ($('sshOn').checked) {
      var sp = Number($('sshPort').value);
      checks.push(['sshHost', !$('sshHost').value.trim() ? T("L'hôte SSH est obligatoire.", 'SSH host is required.') : '']);
      checks.push(['sshPort', !($('sshPort').value.trim() !== '' && Number.isInteger(sp) && sp >= 1 && sp <= 65535) ? T('Port entre 1 et 65535.', 'Port between 1 and 65535.') : '']);
      checks.push(['sshUser', !$('sshUser').value.trim() ? T("L'utilisateur SSH est obligatoire.", 'SSH user is required.') : '']);
      checks.push(['sshKey', $('sshAuth').value === 'key' && !$('sshKey').value.trim() ? T('Indiquez le fichier de clé privée.', 'Specify the private key file.') : '']);
    } else {
      ['sshHost', 'sshPort', 'sshUser', 'sshKey'].forEach(function (k) { checks.push([k, '']); });
    }
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
      type: currentType(), file: fields.file.value, group: fields.group.value, name: fields.name.value, host: fields.host.value, port: fields.port.value,
      user: fields.user.value, password: fields.password.value, database: fields.database.value,
      ssl: $('ssl').checked, readOnly: $('readOnly').checked, production: $('production').checked,
      sshOn: $('sshOn').checked, sshHost: $('sshHost').value, sshPort: $('sshPort').value, sshUser: $('sshUser').value,
      sshAuth: $('sshAuth').value, sshSecret: $('sshSecret').value, sshKey: $('sshKey').value
    };
  }
  function setBusy(busy) { $('testBtn').disabled = busy; $('saveBtn').disabled = busy; }
  function clearStatus() { status.className = ''; status.textContent = ''; }
  function show(kind, text) { status.className = kind; status.textContent = text; }

  $('testBtn').addEventListener('click', function () {
    if (!validate(true)) { return; }
    setBusy(true);
    show('busy', T('Test de la connexion…', 'Testing connection…'));
    vscode.postMessage({ type: 'test', values: values() });
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!validate(true)) { return; }
    setBusy(true);
    show('busy', T('Enregistrement…', 'Saving…'));
    vscode.postMessage({ type: 'save', values: values() });
  });
  $('cancelBtn').addEventListener('click', function () { vscode.postMessage({ type: 'cancel' }); });

  window.addEventListener('message', function (event) {
    var m = event.data;
    if (m && m.type === 'filePicked') { fields.file.value = m.path; suggestName(); return; }
    if (m && m.type === 'keyPicked') { $('sshKey').value = m.path; return; }
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
<html lang="${isFrench() ? 'fr' : 'en'}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${t('Connexion', 'Connection')}</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<main>
  <h1 id="title">${t('Nouvelle connexion', 'New connection')}</h1>
  <p class="lead muted">${t('Renseignez le serveur, testez la connexion, puis enregistrez.', 'Enter the server details, test the connection, then save.')}</p>

  <form id="form" novalidate autocomplete="off">
    <fieldset>
      <legend>${t('Type de base de données', 'Database type')}</legend>
      <div class="types">
        <label><input type="radio" name="type" value="mysql"> MySQL / MariaDB</label>
        <label><input type="radio" name="type" value="postgres"> PostgreSQL</label>
        <label><input type="radio" name="type" value="sqlite"> SQLite</label>
      </div>
    </fieldset>

    <div id="fileBox" hidden>
      <label class="field" for="file">${t('Fichier de la base', 'Database file')}</label>
      <div class="pwd">
        <input type="text" id="file" spellcheck="false" autocomplete="off" placeholder="${t('/chemin/vers/base.db', '/path/to/database.db')}">
        <button type="button" id="pickFile">${t('Parcourir…', 'Browse…')}</button>
      </div>
      <div class="hint">${t("Ouverte en <strong>lecture seule</strong> : le fichier n'est jamais modifié, et il est relu automatiquement s'il change. Il est chargé en mémoire (300 Mo maximum).", 'Opened <strong>read-only</strong>: the file is never modified, and it is reloaded automatically if it changes. It is loaded in memory (300 MB maximum).')}</div>
      <div class="err" id="err-file" role="alert"></div>
    </div>

    <div id="serverBox">
    <details>
      <summary>${t('Importer depuis une URL de connexion', 'Import from a connection URL')}</summary>
      <div class="pwd">
        <input type="url" id="url" placeholder="${t('mysql://utilisateur:motdepasse@hote:3306/base', 'mysql://user:password@host:3306/database')}" aria-label="${t('URL de connexion', 'Connection URL')}" autocomplete="off" spellcheck="false">
        <button type="button" id="importBtn">${t('Importer', 'Import')}</button>
      </div>
      <div class="err" id="urlerr" role="alert"></div>
      <div class="hint">${t('Formats acceptés : mysql://, mariadb://, postgres://, postgresql://. Les champs ci-dessous sont remplis automatiquement.', 'Accepted formats: mysql://, mariadb://, postgres://, postgresql://. The fields below are filled in automatically.')}</div>
    </details>

    <div class="row">
      <div>
        <label class="field" for="host">${t('Hôte', 'Host')}</label>
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
        <label class="field" for="user">${t('Utilisateur', 'User')}</label>
        <input type="text" id="user" spellcheck="false" autocomplete="off">
        <div class="err" id="err-user" role="alert"></div>
      </div>
      <div>
        <label class="field" for="password">${t('Mot de passe', 'Password')}</label>
        <div class="pwd">
          <input type="password" id="password" autocomplete="new-password">
          <button type="button" id="toggle" aria-label="${t('Afficher ou masquer le mot de passe', 'Show or hide the password')}">${t('Afficher', 'Show')}</button>
        </div>
        <div class="err" id="err-password"></div>
      </div>
    </div>

    <div>
      <label class="field" for="database">${t('Base de données', 'Database')}</label>
      <input type="text" id="database" spellcheck="false" autocomplete="off">
      <div class="hint" id="dbhint"></div>
      <div class="err" id="err-database" role="alert"></div>
    </div>

    <fieldset>
      <label class="check"><input type="checkbox" id="ssl"> ${t('Chiffrer la connexion (SSL/TLS)', 'Encrypt the connection (SSL/TLS)')}</label>
    </fieldset>

    <fieldset>
      <legend>${t('Tunnel SSH', 'SSH tunnel')}</legend>
      <label class="check"><input type="checkbox" id="sshOn"> ${t('Se connecter à travers un tunnel SSH', 'Connect through an SSH tunnel')}</label>
      <div id="sshBox" hidden>
        <div class="row">
          <div>
            <label class="field" for="sshHost">${t('Hôte SSH', 'SSH host')}</label>
            <input type="text" id="sshHost" spellcheck="false" autocomplete="off">
            <div class="err" id="err-sshHost" role="alert"></div>
          </div>
          <div class="narrow">
            <label class="field" for="sshPort">Port</label>
            <input type="number" id="sshPort" min="1" max="65535">
            <div class="err" id="err-sshPort" role="alert"></div>
          </div>
        </div>
        <div class="row">
          <div>
            <label class="field" for="sshUser">${t('Utilisateur SSH', 'SSH user')}</label>
            <input type="text" id="sshUser" spellcheck="false" autocomplete="off">
            <div class="err" id="err-sshUser" role="alert"></div>
          </div>
          <div>
            <label class="field" for="sshAuth">${t('Authentification', 'Authentication')}</label>
            <select id="sshAuth">
              <option value="password">${t('Mot de passe', 'Password')}</option>
              <option value="key">${t('Clé privée', 'Private key')}</option>
              <option value="agent">${t('Agent SSH', 'SSH agent')}</option>
            </select>
          </div>
        </div>
        <div id="sshKeyRow">
          <label class="field" for="sshKey">${t('Fichier de clé privée', 'Private key file')}</label>
          <div class="pwd">
            <input type="text" id="sshKey" spellcheck="false" autocomplete="off" placeholder="~/.ssh/id_ed25519">
            <button type="button" id="pickKey">${t('Parcourir…', 'Browse…')}</button>
          </div>
          <div class="err" id="err-sshKey" role="alert"></div>
        </div>
        <div id="sshPwRow">
          <label class="field" id="sshSecretLabel" for="sshSecret">${t('Mot de passe SSH', 'SSH password')}</label>
          <input type="password" id="sshSecret" autocomplete="new-password">
        </div>
        <div class="hint">${t("Les champs « Hôte » et « Port » de la base ci-dessus sont ceux vus <em>depuis le serveur SSH</em> (souvent « localhost »). À la première connexion, l'empreinte du serveur SSH vous est demandée, puis elle est vérifiée à chaque fois. Mot de passe et phrase secrète sont stockés dans le SecretStorage.", 'The database “Host” and “Port” fields above are those seen <em>from the SSH server</em> (often “localhost”). On the first connection, you are asked to confirm the SSH server fingerprint, which is then verified every time. Password and passphrase are stored in SecretStorage.')}</div>
      </div>
    </fieldset>

    <fieldset id="secBox">
      <legend>${t('Sécurité', 'Security')}</legend>
      <label class="check"><input type="checkbox" id="production"> ${t("Base de production (badge d'avertissement, confirmation avant toute écriture)", 'Production database (warning badge, confirmation before any write)')}</label>
      <label class="check" style="margin-top:6px"><input type="checkbox" id="readOnly"> ${t('Lecture seule (aucune écriture : grille et éditeur SQL, refusée aussi par le serveur)', 'Read-only (no writes: grid and SQL editor, also rejected by the server)')}</label>
    </fieldset>

    </div>

    <div>
      <label class="field" for="group">${t("Groupe (dossier de l'arbre)", 'Group (tree folder)')}</label>
      <input type="text" id="group" list="groupList" autocomplete="off" maxlength="100" placeholder="${t('Facultatif : Production, Clients, Local…', 'Optional: Production, Clients, Local…')}">
      <datalist id="groupList"></datalist>
      <div class="err" id="err-group"></div>
    </div>

    <div>
      <label class="field" for="name">${t('Nom affiché', 'Display name')}</label>
      <input type="text" id="name" autocomplete="off">
      <div class="hint">${t("Généré automatiquement à partir de l'utilisateur, de l'hôte et de la base si vous ne le modifiez pas.", 'Generated automatically from the user, host and database if you do not change it.')}</div>
      <div class="err" id="err-name"></div>
    </div>

    <div class="actions">
      <button type="button" id="testBtn">${t('Tester la connexion', 'Test connection')}</button>
      <span class="spacer"></span>
      <button type="button" id="cancelBtn">${t('Annuler', 'Cancel')}</button>
      <button type="submit" id="saveBtn" class="primary">${t('Enregistrer', 'Save')}</button>
    </div>
    <div id="status" role="status" aria-live="polite"></div>
  </form>
</main>
<script id="init" type="application/json" nonce="${nonce}">${data}</script>
<script nonce="${nonce}">${webviewI18n()}${SCRIPT}</script>
</body>
</html>`;
}

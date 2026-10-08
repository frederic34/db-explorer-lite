// Dans un vrai VS Code : activation, commandes, flux SQLite (worker_thread + sql.js sous le Node d'Electron),
// instruction sous le curseur et EXPLAIN. Le contenu des webviews n'est pas inspectable depuis l'hôte
// d'extensions : il est couvert par les tests jsdom (npm test).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const pkg = require('../../../package.json');
const EXT_ID = `${pkg.publisher}.${pkg.name}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, label, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await cond();
    if (v) { return v; }
    await sleep(50);
  }
  throw new Error('délai dépassé : ' + label);
}

suite('DB Explorer Lite dans VS Code', function () {
  let api;
  let dir;
  let dbFile;
  const connId = 'it-sqlite';

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} introuvable`);
    api = await ext.activate();
    assert.ok(api && api.manager, 'API de test absente (DBX_TEST=1 attendu)');

    // Base SQLite créée avec sql.js, comme le ferait n'importe quel outil externe.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-it-'));
    dbFile = path.join(dir, 'it.db');
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run("CREATE TABLE clients (id INTEGER PRIMARY KEY, nom TEXT NOT NULL, ville TEXT);" +
      "INSERT INTO clients VALUES (1,'Alice','Lyon'),(2,'Bob','Paris'),(3,'Chloé',NULL);");
    fs.writeFileSync(dbFile, Buffer.from(db.export()));
    db.close();

    await api.manager.save({ id: connId, name: 'IT SQLite', type: 'sqlite', host: '', port: 0, user: '', file: dbFile, readOnly: true }, undefined);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('l\'extension s\'active', () => {
    assert.strictEqual(vscode.extensions.getExtension(EXT_ID).isActive, true);
  });

  test('toutes les commandes déclarées sont enregistrées', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = pkg.contributes.commands.map((c) => c.command).filter((c) => !registered.has(c));
    assert.deepStrictEqual(missing, []);
  });

  test('arbre : la connexion SQLite se déplie jusqu\'aux colonnes', async () => {
    const roots = await api.tree.getChildren();
    const conn = roots.find((n) => n.config && n.config.id === connId);
    assert.ok(conn, 'connexion visible à la racine');
    const [container] = await api.tree.getChildren(conn);
    assert.strictEqual(container.container, 'main');
    const categories = await api.tree.getChildren(container);
    assert.deepStrictEqual(categories.map((c) => c.kind), ['tables'], 'SQLite : seulement la rubrique des tables');
    const tables = await api.tree.getChildren(categories[0]);
    assert.deepStrictEqual(tables.map((t) => t.table.name), ['clients']);
    const cols = await api.tree.getChildren(tables[0]);
    assert.deepStrictEqual(cols.map((c) => c.column.name), ['id', 'nom', 'ville']);
  });

  test('requête SQLite (worker_thread + WebAssembly sous Electron)', async () => {
    const driver = await api.manager.getDriver(connId);
    const r = await driver.query('SELECT nom FROM clients WHERE ville IS NOT NULL ORDER BY id');
    assert.deepStrictEqual(r.rows, [['Alice'], ['Bob']]);
    await assert.rejects(driver.query('DELETE FROM clients'), /query_only|readonly|read-only|lecture/i);
  });

  async function openSql(text, line, character) {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: text });
    api.associate(doc.uri.toString(), connId);
    const editor = await vscode.window.showTextDocument(doc);
    const pos = new vscode.Position(line, character);
    editor.selection = new vscode.Selection(pos, pos);
    return editor;
  }
  const lastHistory = () => api.history.list()[0];

  test('« Exécuter l\'instruction sous le curseur » n\'exécute que celle-ci', async () => {
    await openSql("SELECT 'un' AS a;\nSELECT 'deux' AS b;\nSELECT 'trois' AS c;", 1, 5);
    await vscode.commands.executeCommand('dbExplorer.runStatement');
    const e = await until(() => { const h = lastHistory(); return h && h.sql.includes('deux') ? h : undefined; }, 'historique');
    assert.strictEqual(e.sql, "SELECT 'deux' AS b");
    assert.strictEqual(e.ok, true);
  });

  test('EXPLAIN : plan SQLite exécuté sur l\'instruction courante', async () => {
    await openSql('SELECT * FROM clients WHERE ville = \'Lyon\';\nSELECT 1;', 0, 3);
    await vscode.commands.executeCommand('dbExplorer.explain');
    const e = await until(() => { const h = lastHistory(); return h && /EXPLAIN QUERY PLAN/.test(h.sql) ? h : undefined; }, 'historique explain');
    assert.ok(e.sql.endsWith("SELECT * FROM clients WHERE ville = 'Lyon'"), e.sql);
    assert.strictEqual(e.ok, true);
  });

  test('requêtes enregistrées : ajout, dossier, ouverture dans un éditeur SQL', async () => {
    const q = await api.saved.add({ name: 'Clients lyonnais', sql: "SELECT * FROM clients WHERE ville = 'Lyon'", folder: 'Tests', connectionId: connId });
    assert.deepStrictEqual(api.saved.folders(), ['Tests']);
    await vscode.commands.executeCommand('dbExplorer.openSaved', { query: q });
    const doc = vscode.window.activeTextEditor.document;
    assert.strictEqual(doc.languageId, 'sql');
    assert.ok(doc.getText().includes("ville = 'Lyon'"));
    await api.saved.remove(q.id);
    assert.deepStrictEqual(api.saved.list(), []);
  });

  test('connexions : groupes et export JSON sans mot de passe', async () => {
    await api.manager.setGroup([connId], 'Tests');
    const roots = await api.tree.getChildren();
    const group = roots.find((n) => n.contextValue === 'group' && n.name === 'Tests');
    assert.ok(group, 'dossier « Tests » à la racine');
    assert.ok(!JSON.stringify(api.manager.list()).includes('password'));
    await api.manager.removeGroup('Tests');
  });
});

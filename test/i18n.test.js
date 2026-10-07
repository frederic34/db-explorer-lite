// Couche bilingue : la langue suit VS Code (ou DBX_LANG), chaque libellé existe en français et en anglais.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { t, isFrench } = require('../.test-build/i18n.js');
const { analyze } = require('../.test-build/sqlGuard.js');
const { diffSchemas } = require('../.test-build/schemaDiff.js');

const withLang = (lang, fn) => { const old = process.env.DBX_LANG; process.env.DBX_LANG = lang; try { return fn(); } finally { if (old === undefined) { delete process.env.DBX_LANG; } else { process.env.DBX_LANG = old; } } };

test('t() suit la langue : fr / fr-CA → français, en / de → anglais', () => {
  assert.equal(withLang('fr', () => t('Bonjour', 'Hello')), 'Bonjour');
  assert.equal(withLang('fr-CA', () => t('Bonjour', 'Hello')), 'Bonjour');
  assert.equal(withLang('en', () => t('Bonjour', 'Hello')), 'Hello');
  assert.equal(withLang('de', () => isFrench()), false);
});

test('messages de garde SQL et script de migration : anglais sans reste de français', () => {
  const frText = withLang('fr', () => JSON.stringify(analyze('DELETE FROM t', 'postgres')));
  const enText = withLang('en', () => JSON.stringify(analyze('DELETE FROM t', 'postgres')));
  assert.notEqual(frText, enText);
  assert.doesNotMatch(enText, /[éèêàç]|sans WHERE|Suppression/);
  const col = (name) => ({ name, type: 'integer', nullable: true, primaryKey: false, default: null });
  const snap = (c, tables) => ({ dbType: 'postgres', container: c, tables: new Map(Object.entries(tables)) });
  const tb = (columns) => ({ isView: false, columns, indexes: [], constraints: [], ddl: '' });
  const a = snap('a', { t: tb([col('id'), col('x')]) });
  const b = snap('b', { t: tb([col('id')]) });
  const en = withLang('en', () => diffSchemas(a, b));
  assert.ok(en.script.length > 0);
  assert.doesNotMatch(en.script + JSON.stringify(en.items), /[éèêàç]/);
});

test('appels t(fr, en) : l\'anglais ne contient pas de lettres accentuées françaises', () => {
  const dir = path.join(__dirname, '..', 'src');
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // t('…', '…') / T('…', '…') en une ligne, littéraux simples ou gabarits
    const re = /\b[tT]\(\s*(?:'(?:[^'\\]|\\.)*'|`[^`]*`)\s*,\s*('(?:[^'\\]|\\.)*'|`[^`]*`)\s*[,)]/g;
    let m;
    while ((m = re.exec(src))) {
      if (/[éèêàùçôîïû]/i.test(m[1]) && !/Chloé|café/i.test(m[1])) { bad.push(`${f}: ${m[1].slice(0, 70)}`); }
    }
  }
  assert.deepEqual(bad, []);
});

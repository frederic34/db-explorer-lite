// Lanceur Mocha exécuté dans l'hôte d'extensions de VS Code.
const path = require('path');
const fs = require('fs');
const Mocha = require('mocha');

exports.run = function run() {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 30000 });
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) {
    mocha.addFile(path.join(__dirname, f));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) en échec`)) : resolve()));
  });
};

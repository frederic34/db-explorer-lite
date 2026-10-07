// npm test : compile, tests unitaires, puis bout en bout sur chaque base joignable.
const { spawnSync } = require('child_process');
const path = require('path');
const { build } = require('./build');

build();
const run = (args) => spawnSync(process.execPath, args, { stdio: 'inherit', cwd: path.join(__dirname, '..') });

let failed = false;
if (run(['--test', 'test/unit.test.js', 'test/tunnel.test.js', 'test/form.test.js', 'test/sqlite.test.js', 'test/er.test.js', 'test/structure.test.js', 'test/refresh.test.js', 'test/connections.test.js', 'test/editor.test.js', 'test/saved.test.js']).status !== 0) {
  failed = true;
}
const only = process.argv[2]; // « pg » ou « my » pour n'en tester qu'une
for (const kind of ['pg', 'my']) {
  if (only && only !== kind) {
    continue;
  }
  for (const script of ['test/e2e.js', 'test/features.js']) {
    if (run([script, kind]).status !== 0) {
      failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);

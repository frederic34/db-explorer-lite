// Compile les modules testés (vscode remplacé par un faux) dans .test-build/.
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
exports.build = () =>
  esbuild.buildSync({
    entryPoints: {
      panel: path.join(root, 'src/resultsPanel.ts'),
      drivers: path.join(root, 'src/drivers.ts'),
      editing: path.join(root, 'src/editing.ts'),
      browse: path.join(root, 'src/browse.ts'),
      util: path.join(root, 'src/util.ts'),
      sqlGuard: path.join(root, 'src/sqlGuard.ts'),
      completion: path.join(root, 'src/completion.ts'),
      history: path.join(root, 'src/history.ts'),
      tunnel: path.join(root, 'src/tunnel.ts'),
      form: path.join(root, 'src/connectionForm.ts'),
      manager: path.join(root, 'src/connectionManager.ts'),
      schemaCache: path.join(root, 'src/schemaCache.ts'),
    },
    outdir: path.join(root, '.test-build'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['pg-native', 'cpu-features', '*.node'],
    alias: { vscode: path.join(__dirname, 'vscode-stub.js') },
    logLevel: 'error',
  });

if (require.main === module) {
  exports.build();
}

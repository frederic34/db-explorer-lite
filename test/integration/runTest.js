// Tests d'intégration dans un vrai VS Code (Electron) : npm run test:integration
// Télécharge VS Code au premier lancement (réseau requis). Sous Linux sans écran : xvfb-run -a npm run test:integration
const path = require('path');
const { runTests } = require('@vscode/test-electron');

(async () => {
  const root = path.resolve(__dirname, '../..');
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.resolve(__dirname, 'suite/index.js'),
      extensionTestsEnv: { DBX_TEST: '1' },
      launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
      version: process.env.VSCODE_VERSION || 'stable',
    });
  } catch (err) {
    console.error('Échec des tests d\'intégration :', err.message || err);
    process.exit(1);
  }
})();

const panels = (global.__vsPanels = global.__vsPanels || []);
global.__replies = global.__replies || [];
module.exports = {
  ViewColumn: { Beside: 2 },
  window: {
    createWebviewPanel: () => {
      const p = { handlers: [], disposeCbs: [], html: '',
        webview: {
          set html(v) { p.html = v; }, get html() { return p.html; },
          onDidReceiveMessage(h) { p.handlers.push(h); },
          postMessage(m) { global.__replies.push(m); const w = global.__vsWin; if (w) { w.dispatchEvent(new w.MessageEvent('message', { data: m })); } return Promise.resolve(true); },
        },
        onDidDispose(cb) { p.disposeCbs.push(cb); }, reveal() {}, dispose() {} };
      panels.push(p); return p;
    },
    showWarningMessage: async (...args) => { global.__modals = (global.__modals || []).concat([args[0]]); return global.__nextChoice; },
    showSaveDialog: async () => global.__saveUri,
    showInformationMessage() {},
  },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }), fs: { writeFile: async (u, c) => { global.__written = { u, c }; } } },
};

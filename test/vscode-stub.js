// Faux module « vscode » pour les tests : panneaux web, boîtes de dialogue, configuration, événements.
const panels = (global.__vsPanels = global.__vsPanels || []);
global.__replies = global.__replies || [];

class EventEmitter {
  constructor() { this.listeners = []; this.event = (l) => { this.listeners.push(l); return { dispose() {} }; }; }
  fire(v) { this.listeners.forEach((l) => l(v)); }
  dispose() { this.listeners = []; }
}

module.exports = {
  EventEmitter,
  ViewColumn: { Beside: 2, Active: 1 },
  Uri: { file: (p) => ({ fsPath: p }) },
  window: {
    createWebviewPanel: (_type, title) => {
      const p = { title, handlers: [], disposeCbs: [], html: '', disposed: false,
        webview: {
          set html(v) { p.html = v; }, get html() { return p.html; },
          onDidReceiveMessage(h) { p.handlers.push(h); },
          postMessage(m) { global.__replies.push(m); const w = global.__vsWin; if (w) { w.dispatchEvent(new w.MessageEvent('message', { data: m })); } return Promise.resolve(true); },
        },
        onDidDispose(cb) { p.disposeCbs.push(cb); },
        reveal() {},
        dispose() { p.disposed = true; p.disposeCbs.forEach((cb) => cb()); } };
      panels.push(p); return p;
    },
    showWarningMessage: async (...args) => { global.__modals = (global.__modals || []).concat([args[0]]); global.__modalDetails = (global.__modalDetails || []).concat([args[1] && args[1].detail]); return global.__nextChoice; },
    showErrorMessage: async (m) => { global.__errors = (global.__errors || []).concat([m]); },
    showSaveDialog: async () => global.__saveUri,
    showOpenDialog: async () => global.__openPick,
    withProgress: async (_o, task) => task({ report() {} }, { onCancellationRequested(cb) { if (global.__cancelNow) { cb(); } return { dispose() {} }; } }),
    showInformationMessage(m) { global.__infos = (global.__infos || []).concat([m]); },
    showQuickPick: async (items) => {
      const want = (global.__picks || []).shift();
      const list = await items;
      return want === undefined ? undefined : list.find((i) => (i.label || i).includes(want));
    },
    showInputBox: async () => (global.__inputs || []).shift(),
  },
  ProgressLocation: { Notification: 15, Window: 10 },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }), fs: { writeFile: async (u, c) => { global.__written = { u, c }; } } },
};

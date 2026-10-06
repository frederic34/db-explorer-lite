import * as vscode from 'vscode';
import {
  analyzeContext,
  complete,
  Completion,
  currentStatement,
  referencedTables,
  tablesNeeded,
} from './completion';
import { SchemaCache } from './schemaCache';
import { ConnectionConfig } from './types';

const KINDS: Record<Completion['kind'], vscode.CompletionItemKind> = {
  table: vscode.CompletionItemKind.Struct,
  view: vscode.CompletionItemKind.Interface,
  column: vscode.CompletionItemKind.Field,
  schema: vscode.CompletionItemKind.Module,
  keyword: vscode.CompletionItemKind.Keyword,
};

/** Attend `p` au plus `ms` millisecondes (la saisie ne doit jamais rester bloquée sur le réseau). */
async function within(p: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);
}

/** Auto-complétion SQL : tables, colonnes (avec alias) et mots-clés de la connexion de l'éditeur. */
export function registerCompletion(
  cache: SchemaCache,
  connectionOf: (doc: vscode.TextDocument) => ConnectionConfig | undefined,
): vscode.Disposable {
  return vscode.languages.registerCompletionItemProvider(
    { language: 'sql' },
    {
      async provideCompletionItems(doc, pos) {
        const cfg = connectionOf(doc);
        if (!cfg) {
          return undefined;
        }
        const { statement, before } = currentStatement(doc.getText(), doc.offsetAt(pos), cfg.type);
        const ctx = analyzeContext(before, cfg.type);
        if (!ctx) {
          return undefined;
        }
        await within(cache.load(cfg.id), 3000);
        const refs = referencedTables(statement, cfg.type);
        const needed = tablesNeeded(ctx, refs, cache.view(cfg.id, cfg));
        await within(Promise.all(needed.map((t) => cache.loadColumns(cfg.id, t.container, t.table))), 3000);

        const items = complete(ctx, refs, cache.view(cfg.id, cfg)).map((c) => {
          const item = new vscode.CompletionItem(c.label, KINDS[c.kind]);
          item.insertText = c.insertText;
          item.detail = c.detail;
          // Les colonnes d'abord, puis les tables, puis les mots-clés.
          item.sortText = `${c.kind === 'column' ? 0 : c.kind === 'keyword' ? 2 : 1}${c.label}`;
          return item;
        });
        return new vscode.CompletionList(items, false);
      },
    },
    '.',
  );
}

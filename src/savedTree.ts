import * as vscode from 'vscode';
import { SavedQueries, SavedQuery } from './savedQueries';
import { t } from './i18n';

export class SavedFolderNode extends vscode.TreeItem {
  constructor(public readonly name: string, count: number) {
    super(name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'savedFolder';
    this.iconPath = new vscode.ThemeIcon('folder');
    this.description = String(count);
  }
}

export class SavedQueryNode extends vscode.TreeItem {
  constructor(public readonly query: SavedQuery) {
    super(query.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'savedQuery';
    this.iconPath = new vscode.ThemeIcon('file-code');
    this.description = query.sql.replace(/\s+/g, ' ').slice(0, 60);
    this.tooltip = new vscode.MarkdownString().appendCodeblock(query.sql.slice(0, 1500), 'sql');
    this.command = { command: 'dbExplorer.openSaved', title: t('Ouvrir', 'Open'), arguments: [this] };
  }
}

export type SavedNode = SavedFolderNode | SavedQueryNode;

export class SavedTreeProvider implements vscode.TreeDataProvider<SavedNode> {
  private readonly emitter = new vscode.EventEmitter<SavedNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly saved: SavedQueries) {
    saved.onDidChange(() => this.emitter.fire(undefined));
  }

  getTreeItem(element: SavedNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SavedNode): SavedNode[] {
    const all = this.saved.list();
    const byName = (a: SavedQuery, b: SavedQuery) => a.name.localeCompare(b.name);
    if (!element) {
      return [
        ...this.saved.folders().map((f) => new SavedFolderNode(f, all.filter((q) => q.folder === f).length)),
        ...all.filter((q) => !q.folder).sort(byName).map((q) => new SavedQueryNode(q)),
      ];
    }
    if (element instanceof SavedFolderNode) {
      return all.filter((q) => q.folder === element.name).sort(byName).map((q) => new SavedQueryNode(q));
    }
    return [];
  }
}

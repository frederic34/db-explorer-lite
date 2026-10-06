// Modèle et disposition du diagramme des relations (entité-association). Fonctions pures, sans VS Code.

export interface ErColumn {
  name: string;
  type: string;
  pk: boolean;
  /** Clé étrangère sur une seule colonne vers une table du diagramme. */
  fk?: { table: string; column: string };
  /** Clé étrangère vers une table absente du diagramme (autre base ou schéma) : « schéma.table ». */
  external?: string;
}

export interface ErTable {
  name: string;
  columns: ErColumn[];
}

export interface ErEdge {
  /** Table qui porte la clé étrangère. */
  from: string;
  fromCol: string;
  /** Table référencée. */
  to: string;
  toCol: string;
}

export interface ErNode {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Colonnes affichées. */
  rows: ErColumn[];
  /** Colonnes non affichées (mode « clés seulement » ou table très large). */
  hidden: number;
}

export interface ErLayout {
  nodes: ErNode[];
  width: number;
  height: number;
}

export const CHAR_W = 7.4;
export const ROW_H = 18;
export const HEAD_H = 28;
export const PAD = 10;
const MAX_ROWS = 25;
const LAYER_GAP = 100;
const NODE_GAP = 28;
const MAX_COLUMN_HEIGHT = 1500;

/** Liens entre tables du diagramme (un par colonne de clé étrangère). */
export function buildEdges(tables: ErTable[]): ErEdge[] {
  const names = new Set(tables.map((t) => t.name));
  const edges: ErEdge[] = [];
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.fk && names.has(c.fk.table)) {
        edges.push({ from: t.name, fromCol: c.name, to: c.fk.table, toCol: c.fk.column });
      }
    }
  }
  return edges;
}

function visibleRows(t: ErTable, keysOnly: boolean): { rows: ErColumn[]; hidden: number } {
  const base = keysOnly ? t.columns.filter((c) => c.pk || c.fk || c.external) : t.columns;
  const rows = base.slice(0, MAX_ROWS);
  return { rows, hidden: t.columns.length - rows.length };
}

function size(t: ErTable, rows: ErColumn[], hidden: number): { w: number; h: number } {
  const line = (c: ErColumn): number => (c.name.length + c.type.length + 8 + (c.external ? c.external.length + 3 : 0)) * CHAR_W;
  const w = Math.max(t.name.length * CHAR_W * 1.15, ...rows.map(line), 110) + PAD * 2;
  const h = HEAD_H + Math.max(rows.length, 1) * ROW_H + (hidden > 0 ? ROW_H : 0) + 6;
  return { w: Math.ceil(w), h };
}

/**
 * Disposition en couches : une table est toujours à droite des tables qu'elle référence ;
 * l'ordre dans chaque couche est affiné pour limiter les croisements. Les tables sans aucun
 * lien sont rangées en grille sous le diagramme.
 */
export function layoutEr(tables: ErTable[], edges: ErEdge[], opts: { keysOnly: boolean }): ErLayout {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const info = new Map<string, { rows: ErColumn[]; hidden: number; w: number; h: number }>();
  for (const t of tables) {
    const v = visibleRows(t, opts.keysOnly);
    info.set(t.name, { ...v, ...size(t, v.rows, v.hidden) });
  }

  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  for (const t of tables) {
    parents.set(t.name, new Set());
    children.set(t.name, new Set());
  }
  for (const e of edges) {
    if (e.from !== e.to && byName.has(e.from) && byName.has(e.to)) {
      parents.get(e.from)!.add(e.to);
      children.get(e.to)!.add(e.from);
    }
  }
  const linked = tables.filter((t) => parents.get(t.name)!.size > 0 || children.get(t.name)!.size > 0).map((t) => t.name);
  const isolated = tables.filter((t) => !linked.includes(t.name)).map((t) => t.name).sort();

  // Couches : 1 + la plus profonde des tables référencées ; les cycles sont coupés à l'arc qui revient.
  const layer = new Map<string, number>();
  const state = new Map<string, 'visiting' | 'done'>();
  const depth = (n: string): number => {
    if (state.get(n) === 'done') {
      return layer.get(n)!;
    }
    state.set(n, 'visiting');
    let d = 0;
    for (const p of [...parents.get(n)!].sort()) {
      if (state.get(p) !== 'visiting') {
        d = Math.max(d, depth(p) + 1);
      }
    }
    state.set(n, 'done');
    layer.set(n, d);
    return d;
  };
  [...linked].sort().forEach(depth);

  const layers: string[][] = [];
  for (const n of [...linked].sort()) {
    (layers[layer.get(n)!] ??= []).push(n);
  }
  for (let i = 0; i < layers.length; i++) {
    layers[i] ??= [];
  }

  // Barycentres : quelques allers-retours pour rapprocher chaque table de ses voisines.
  const order = new Map<string, number>();
  const reindex = (): void => layers.forEach((l) => l.forEach((n, i) => order.set(n, i)));
  reindex();
  const sweep = (idx: number, neighbours: (n: string) => Set<string>): void => {
    const l = layers[idx];
    const score = new Map<string, number>();
    for (const n of l) {
      const ns = [...neighbours(n)].filter((m) => layer.get(m) !== idx);
      score.set(n, ns.length ? ns.reduce((a, m) => a + (order.get(m) ?? 0), 0) / ns.length : order.get(n)!);
    }
    l.sort((a, b) => score.get(a)! - score.get(b)! || a.localeCompare(b));
    l.forEach((n, i) => order.set(n, i));
  };
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < layers.length; i++) sweep(i, (n) => parents.get(n)!);
    for (let i = layers.length - 2; i >= 0; i--) sweep(i, (n) => children.get(n)!);
  }

  const nodes: ErNode[] = [];
  let x = 0;
  let maxY = 0;
  for (const l of layers) {
    if (l.length === 0) {
      continue;
    }
    // Une couche trop haute est répartie en plusieurs colonnes.
    const cols: string[][] = [[]];
    let y = 0;
    for (const n of l) {
      const h = info.get(n)!.h;
      if (y > 0 && y + h > MAX_COLUMN_HEIGHT) {
        cols.push([]);
        y = 0;
      }
      cols[cols.length - 1].push(n);
      y += h + NODE_GAP;
    }
    for (const col of cols) {
      const w = Math.max(...col.map((n) => info.get(n)!.w));
      let cy = 0;
      for (const n of col) {
        const i = info.get(n)!;
        nodes.push({ name: n, x, y: cy, w: i.w, h: i.h, rows: i.rows, hidden: i.hidden });
        cy += i.h + NODE_GAP;
      }
      maxY = Math.max(maxY, cy - NODE_GAP);
      x += w + LAYER_GAP;
    }
  }
  let width = Math.max(0, x - LAYER_GAP);

  if (isolated.length > 0) {
    const perRow = Math.max(1, Math.min(8, Math.ceil(Math.sqrt(isolated.length * 1.6))));
    const top = linked.length > 0 ? maxY + 70 : 0;
    let cx = 0;
    let cy = top;
    let rowH = 0;
    isolated.forEach((n, i) => {
      const inf = info.get(n)!;
      if (i > 0 && i % perRow === 0) {
        cx = 0;
        cy += rowH + NODE_GAP;
        rowH = 0;
      }
      nodes.push({ name: n, x: cx, y: cy, w: inf.w, h: inf.h, rows: inf.rows, hidden: inf.hidden });
      cx += inf.w + NODE_GAP;
      rowH = Math.max(rowH, inf.h);
      width = Math.max(width, cx - NODE_GAP);
    });
    maxY = cy + rowH;
  }
  return { nodes, width: Math.ceil(width), height: Math.ceil(maxY) };
}

/** Texte Mermaid `erDiagram` du schéma (pour le coller dans une documentation). */
export function toMermaid(tables: ErTable[], edges: ErEdge[]): string {
  const id = (s: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, "'")}"`);
  const type = (t: string): string => t.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
  const lines = ['erDiagram'];
  for (const e of edges) {
    lines.push(`  ${id(e.to)} ||--o{ ${id(e.from)} : "${e.fromCol}"`);
  }
  for (const t of tables) {
    lines.push(`  ${id(t.name)} {`);
    for (const c of t.columns) {
      const keys = [c.pk ? 'PK' : '', c.fk || c.external ? 'FK' : ''].filter(Boolean).join(',');
      lines.push(`    ${type(c.type)} ${/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name) ? c.name : c.name.replace(/[^A-Za-z0-9_]+/g, '_')}${keys ? ' ' + keys : ''}`);
    }
    lines.push('  }');
  }
  return lines.join('\n') + '\n';
}

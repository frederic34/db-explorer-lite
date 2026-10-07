import { ConstraintInfo, DbType, IndexInfo, StructureColumn, TableStructure } from './types';
import { quoteIdent } from './util';

export interface Snapshot {
  dbType: DbType;
  /** Base (MySQL), schéma (PostgreSQL) ou « main » (SQLite). */
  container: string;
  tables: Map<string, TableStructure>;
}

export type DiffObject = 'table' | 'view' | 'column' | 'index' | 'constraint';
export type DiffChange = 'missing' | 'extra' | 'changed';

export interface DiffItem {
  table: string;
  object: DiffObject;
  name: string;
  /** missing = présent dans la référence A, absent de B ; extra = l'inverse. */
  change: DiffChange;
  detail: string;
}

export interface SchemaDiff {
  items: DiffItem[];
  /** Script qui met B au niveau de A (suppressions en commentaire). */
  script: string;
}

// ---------------------------------------------------------------------------------------------
// Normalisation : deux schémas équivalents ne doivent produire aucune différence.

const INT_WIDTH = /\b(bigint|int|integer|smallint|mediumint)\(\d+\)/g;

function normType(t: string): string {
  return t.toLowerCase().replace(/\s+/g, ' ').trim().replace(INT_WIDTH, '$1');
}

function normDefault(d: string | null, container: string): string {
  if (d === null) {
    return '';
  }
  let s = d.trim();
  if (/^nextval\(/i.test(s)) {
    return 'nextval';
  }
  s = s.replace(/::[a-z_ ]+(\([0-9, ]*\))?(\[\])?/gi, '').toLowerCase();
  s = s.replace(new RegExp(`${escapeRe(container.toLowerCase())}\\.`, 'g'), '');
  s = s.replace(/\(\)$/, '').replace(/^\((.*)\)$/s, '$1');
  return s.replace(/^'(.*)'$/s, "'$1'");
}

function normDefinition(d: string, container: string): string {
  return d
    .toLowerCase()
    .replace(/["`]/g, '')
    .replace(new RegExp(`\\b${escapeRe(container.toLowerCase())}\\.`, 'g'), '')
    .replace(/::[a-z_ ]+(\([0-9, ]*\))?/g, '')
    .replace(/\s+/g, '');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------------------------
// Génération de SQL pour la base cible B.

class Gen {
  constructor(
    private readonly dbType: DbType,
    private readonly from: string,
    private readonly to: string,
  ) {}

  q = (n: string): string => quoteIdent(this.dbType, n);

  table(name: string): string {
    return this.dbType === 'sqlite' ? this.q(name) : `${this.q(this.to)}.${this.q(name)}`;
  }

  /** Réécrit les références à la base / au schéma de A en celles de B dans une définition. */
  retarget(def: string): string {
    if (this.dbType === 'sqlite' || this.from === this.to) {
      return def;
    }
    const re = new RegExp(`(^|[^\\w"\`])(["\`]?)${escapeRe(this.from)}\\2\\.`, 'g');
    return def.replace(re, (_m, pre: string, quote: string) => `${pre}${quote}${this.to}${quote}.`);
  }

  private mysqlDefault(d: string): string {
    return /^'.*'$/s.test(d) || /^-?\d+(\.\d+)?$/.test(d) || /\(/.test(d) || /^(null|current_timestamp|true|false)$/i.test(d)
      ? d
      : `'${d.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  }

  /** Définition d'une colonne (sans « ALTER ») ; `note` reçoit ce que l'on ne sait pas reproduire. */
  column(c: StructureColumn, note: string[]): string {
    const name = this.q(c.name);
    if (this.dbType === 'postgres') {
      const nextval = c.default !== null && /^nextval\(/i.test(c.default);
      const serial = nextval && /^(integer|bigint|smallint)$/i.test(c.type)
        ? { integer: 'serial', bigint: 'bigserial', smallint: 'smallserial' }[c.type.toLowerCase() as 'integer']
        : undefined;
      let out = `${name} ${serial ?? c.type}`;
      if (c.extra && /IDENTITY/i.test(c.extra)) {
        out += ` ${c.extra}`;
      } else if (c.extra && /GENERATED/i.test(c.extra)) {
        out += ` GENERATED ALWAYS AS (${c.default ?? '…'}) STORED`;
      } else if (c.default !== null && !serial) {
        out += ` DEFAULT ${c.default}`;
      }
      return c.nullable || serial ? out : `${out} NOT NULL`;
    }
    if (this.dbType === 'mysql') {
      let out = `${name} ${c.type}`;
      if (c.extra && /GENERATED|PERSISTENT/i.test(c.extra)) {
        note.push(`colonne générée « ${c.name} » : expression à recopier à la main`);
      }
      out += c.nullable ? ' NULL' : ' NOT NULL';
      if (c.default !== null) {
        out += ` DEFAULT ${this.mysqlDefault(c.default)}`;
      }
      if (c.extra && /auto_increment/i.test(c.extra)) {
        out += ' AUTO_INCREMENT';
      }
      return out;
    }
    let out = `${name} ${c.type}`.trim();
    if (!c.nullable && !c.primaryKey) {
      out += ' NOT NULL';
    }
    if (c.default !== null) {
      out += ` DEFAULT ${c.default}`;
    }
    return out;
  }

  constraintClause(k: ConstraintInfo): string {
    const def = this.retarget(k.definition);
    if (k.kind === 'PRIMARY KEY') {
      return this.dbType === 'postgres' ? `CONSTRAINT ${this.q(k.name)} PRIMARY KEY ${def}` : `PRIMARY KEY ${def}`;
    }
    return `CONSTRAINT ${this.q(k.name)} ${k.kind} ${def}`;
  }

  indexSql(t: string, ix: IndexInfo): string {
    const cols = ix.columns.map((c) => this.q(c)).join(', ');
    const using = this.dbType === 'postgres' && ix.method && ix.method !== 'btree' ? ` USING ${ix.method}` : '';
    return `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${this.q(ix.name)} ON ${this.table(t)}${using} (${cols});`;
  }

  dropIndex(t: string, name: string): string {
    return this.dbType === 'mysql'
      ? `DROP INDEX ${this.q(name)} ON ${this.table(t)};`
      : `DROP INDEX ${this.dbType === 'postgres' ? this.q(this.to) + '.' : ''}${this.q(name)};`;
  }

  dropConstraint(t: string, k: ConstraintInfo): string {
    const tn = this.table(t);
    if (this.dbType === 'mysql') {
      if (k.kind === 'PRIMARY KEY') {
        return `ALTER TABLE ${tn} DROP PRIMARY KEY;`;
      }
      if (k.kind === 'FOREIGN KEY') {
        return `ALTER TABLE ${tn} DROP FOREIGN KEY ${this.q(k.name)};`;
      }
      return `ALTER TABLE ${tn} DROP ${k.kind === 'CHECK' ? 'CHECK' : 'INDEX'} ${this.q(k.name)};`;
    }
    return `ALTER TABLE ${tn} DROP CONSTRAINT ${this.q(k.name)};`;
  }

  addConstraint(t: string, k: ConstraintInfo): string {
    return `ALTER TABLE ${this.table(t)} ADD ${this.constraintClause(k)};`;
  }
}

/** Tables triées pour que celles qui sont référencées soient créées d'abord. */
function creationOrder(names: string[], tables: Map<string, TableStructure>, container: string): string[] {
  const set = new Set(names);
  const deps = new Map<string, Set<string>>();
  for (const n of names) {
    const d = new Set<string>();
    for (const k of tables.get(n)?.constraints ?? []) {
      if (k.kind !== 'FOREIGN KEY') {
        continue;
      }
      const m = /REFERENCES\s+((?:["`][^"`]+["`]|[\w$]+)(?:\s*\.\s*(?:["`][^"`]+["`]|[\w$]+))?)/i.exec(k.definition);
      const ref = m?.[1].split('.').pop()?.trim().replace(/^["`]|["`]$/g, '');
      if (ref && ref !== n && set.has(ref)) {
        d.add(ref);
      }
    }
    deps.set(n, d);
  }
  void container;
  const out: string[] = [];
  const done = new Set<string>();
  const visit = (n: string, stack: Set<string>) => {
    if (done.has(n) || stack.has(n)) {
      return;
    }
    stack.add(n);
    for (const d of deps.get(n) ?? []) {
      visit(d, stack);
    }
    stack.delete(n);
    done.add(n);
    out.push(n);
  };
  [...names].sort().forEach((n) => visit(n, new Set()));
  return out;
}

// ---------------------------------------------------------------------------------------------

/** Compare A (référence) et B (à mettre à niveau) et produit les différences et le script de migration. */
export function diffSchemas(a: Snapshot, b: Snapshot): SchemaDiff {
  const dbType = a.dbType;
  const g = new Gen(dbType, a.container, b.container);
  const items: DiffItem[] = [];
  const create: string[] = [];
  const alter: string[] = [];
  const drops: string[] = [];
  const manual: string[] = [];
  const add = (table: string, object: DiffObject, name: string, change: DiffChange, detail: string) =>
    items.push({ table, object, name, change, detail });

  const names = (m: Map<string, unknown>) => [...m.keys()].sort((x, y) => x.localeCompare(y));
  const onlyA = names(a.tables).filter((n) => !b.tables.has(n));
  const onlyB = names(b.tables).filter((n) => !a.tables.has(n));
  const both = names(a.tables).filter((n) => b.tables.has(n));

  // --- Tables et vues absentes de B
  for (const n of creationOrder(onlyA, a.tables, a.container)) {
    const s = a.tables.get(n) as TableStructure;
    if (s.isView) {
      add(n, 'view', n, 'missing', 'vue absente de B');
      create.push(`-- Vue « ${n} » à créer (définition de A) :\n${s.ddl.split('\n').map((l) => `-- ${l}`).join('\n')}`);
      continue;
    }
    add(n, 'table', n, 'missing', `table absente de B (${s.columns.length} colonnes, ${s.indexes.filter((i) => !i.primary).length} index)`);
    const note: string[] = [];
    const lines = s.columns.map((c) => `  ${g.column(c, note)}`);
    const owned = new Set(s.constraints.map((k) => k.name));
    for (const k of s.constraints) {
      lines.push(`  ${g.constraintClause(k)}`);
    }
    const plain = s.indexes.filter((i) => !i.primary && !owned.has(i.name));
    if (dbType === 'mysql') {
      for (const ix of plain) {
        lines.push(`  ${ix.unique ? 'UNIQUE ' : ''}KEY ${g.q(ix.name)} (${ix.columns.map((c) => g.q(c)).join(', ')})`);
      }
    }
    let sql = `CREATE TABLE ${g.table(n)} (\n${lines.join(',\n')}\n);`;
    if (dbType !== 'mysql') {
      sql += plain.map((ix) => '\n' + g.indexSql(n, ix)).join('');
    }
    create.push((note.length ? note.map((x) => `-- ${x}\n`).join('') : '') + sql);
  }

  // --- Tables et vues en trop dans B
  for (const n of onlyB) {
    const s = b.tables.get(n) as TableStructure;
    add(n, s.isView ? 'view' : 'table', n, 'extra', `${s.isView ? 'vue' : 'table'} absente de A`);
    drops.push(`-- DROP ${s.isView ? 'VIEW' : 'TABLE'} ${g.table(n)};`);
  }

  // --- Tables communes
  for (const n of both) {
    const sa = a.tables.get(n) as TableStructure;
    const sb = b.tables.get(n) as TableStructure;
    if (sa.isView || sb.isView) {
      if (sa.isView !== sb.isView) {
        add(n, 'table', n, 'changed', sa.isView ? 'vue dans A, table dans B' : 'table dans A, vue dans B');
        manual.push(`-- « ${n} » est une ${sa.isView ? 'vue' : 'table'} dans A et une ${sa.isView ? 'table' : 'vue'} dans B : à traiter à la main.`);
      } else if (normDefinition(sa.ddl, a.container) !== normDefinition(sb.ddl, b.container)) {
        add(n, 'view', n, 'changed', 'définition de la vue différente');
        manual.push(`-- Vue « ${n} » : définition différente, reprendre celle de A :\n${sa.ddl.split('\n').map((l) => `-- ${l}`).join('\n')}`);
      }
      continue;
    }
    const tn = g.table(n);
    const note: string[] = [];
    const stmts: string[] = [];

    // colonnes
    const cb = new Map(sb.columns.map((c) => [c.name, c]));
    const ca = new Map(sa.columns.map((c) => [c.name, c]));
    for (const c of sa.columns) {
      const o = cb.get(c.name);
      if (!o) {
        add(n, 'column', c.name, 'missing', `colonne absente de B (${c.type}${c.nullable ? '' : ', NOT NULL'})`);
        stmts.push(dbType === 'sqlite' ? `ALTER TABLE ${tn} ADD COLUMN ${g.column(c, note)};` : `ALTER TABLE ${tn} ADD COLUMN ${g.column(c, note)};`);
        continue;
      }
      const diffs: string[] = [];
      const typeDiff = normType(c.type) !== normType(o.type);
      const nullDiff = c.nullable !== o.nullable && !(c.primaryKey && o.primaryKey);
      const defDiff = normDefault(c.default, a.container) !== normDefault(o.default, b.container) && !(c.extra && /GENERATED/i.test(c.extra));
      const extraDiff =
        (c.extra ?? '').toLowerCase().replace(/\s+/g, ' ') !== (o.extra ?? '').toLowerCase().replace(/\s+/g, ' ') &&
        !/^(virtual|stored)? ?generated$/i.test(c.extra ?? '');
      if (typeDiff) { diffs.push(`type ${o.type} → ${c.type}`); }
      if (nullDiff) { diffs.push(c.nullable ? 'NOT NULL → NULL' : 'NULL → NOT NULL'); }
      if (defDiff) { diffs.push(`défaut ${o.default ?? '∅'} → ${c.default ?? '∅'}`); }
      if (extraDiff) { diffs.push(`${o.extra ?? '∅'} → ${c.extra ?? '∅'}`); }
      if (diffs.length === 0) {
        continue;
      }
      add(n, 'column', c.name, 'changed', diffs.join(' ; '));
      if (dbType === 'postgres') {
        const col = g.q(c.name);
        if (typeDiff) { stmts.push(`ALTER TABLE ${tn} ALTER COLUMN ${col} TYPE ${c.type};`); }
        if (nullDiff) { stmts.push(`ALTER TABLE ${tn} ALTER COLUMN ${col} ${c.nullable ? 'DROP' : 'SET'} NOT NULL;`); }
        if (defDiff) {
          stmts.push(c.default === null ? `ALTER TABLE ${tn} ALTER COLUMN ${col} DROP DEFAULT;` : `ALTER TABLE ${tn} ALTER COLUMN ${col} SET DEFAULT ${c.default};`);
        }
        if (extraDiff) { stmts.push(`-- colonne « ${c.name} » : identité / génération différente (${o.extra ?? '∅'} → ${c.extra ?? '∅'}), à traiter à la main`); }
      } else if (dbType === 'mysql') {
        stmts.push(`ALTER TABLE ${tn} MODIFY COLUMN ${g.column(c, note)};`);
      } else {
        stmts.push(`-- SQLite ne sait pas modifier la colonne « ${c.name} » (${diffs.join(' ; ')}) : recréer la table.`);
      }
    }
    for (const c of sb.columns) {
      if (!ca.has(c.name)) {
        add(n, 'column', c.name, 'extra', 'colonne absente de A');
        stmts.push(`-- ALTER TABLE ${tn} DROP COLUMN ${g.q(c.name)};`);
      }
    }

    // index (hors clé primaire et hors ceux portés par une contrainte)
    const ownedA = new Set(sa.constraints.map((k) => k.name));
    const ownedB = new Set(sb.constraints.map((k) => k.name));
    const ixA = new Map(sa.indexes.filter((i) => !i.primary && !ownedA.has(i.name)).map((i) => [i.name, i]));
    const ixB = new Map(sb.indexes.filter((i) => !i.primary && !ownedB.has(i.name)).map((i) => [i.name, i]));
    for (const [name, ix] of ixA) {
      const o = ixB.get(name);
      if (!o) {
        add(n, 'index', name, 'missing', `index (${ix.columns.join(', ')})${ix.unique ? ' unique' : ''} absent de B`);
        stmts.push(g.indexSql(n, ix));
      } else if (o.columns.join() !== ix.columns.join() || o.unique !== ix.unique) {
        add(n, 'index', name, 'changed', `(${o.columns.join(', ')})${o.unique ? ' unique' : ''} → (${ix.columns.join(', ')})${ix.unique ? ' unique' : ''}`);
        stmts.push(g.dropIndex(n, name), g.indexSql(n, ix));
      }
    }
    for (const [name, ix] of ixB) {
      if (!ixA.has(name)) {
        add(n, 'index', name, 'extra', `index (${ix.columns.join(', ')}) absent de A`);
        stmts.push(`-- ${g.dropIndex(n, name)}`);
      }
    }

    // contraintes
    const kA = new Map(sa.constraints.map((k) => [k.name, k]));
    const kB = new Map(sb.constraints.map((k) => [k.name, k]));
    for (const [name, k] of kA) {
      const o = kB.get(name);
      if (!o) {
        add(n, 'constraint', name, 'missing', `${k.kind} ${k.definition} absente de B`);
        stmts.push(k.kind === 'PRIMARY KEY' && kB.size > 0 && sb.constraints.some((x) => x.kind === 'PRIMARY KEY')
          ? `-- clé primaire différente : à traiter à la main`
          : g.addConstraint(n, k));
      } else if (o.kind !== k.kind || normDefinition(o.definition, b.container) !== normDefinition(k.definition, a.container)) {
        add(n, 'constraint', name, 'changed', `${o.kind} ${o.definition} → ${k.kind} ${k.definition}`);
        if (k.kind === 'PRIMARY KEY') {
          stmts.push(`-- clé primaire différente (${o.definition} → ${k.definition}) : à traiter à la main`);
        } else {
          stmts.push(g.dropConstraint(n, o), g.addConstraint(n, k));
        }
      }
    }
    for (const [name, k] of kB) {
      if (!kA.has(name)) {
        add(n, 'constraint', name, 'extra', `${k.kind} ${k.definition} absente de A`);
        stmts.push(`-- ${g.dropConstraint(n, k)}`);
      }
    }

    if (stmts.length > 0 || note.length > 0) {
      alter.push([`-- Table ${n}`, ...note.map((x) => `-- ${x}`), ...stmts].join('\n'));
    }
  }

  const sections: string[] = [
    `-- Mise à niveau de « ${b.container} » (B) pour qu'elle corresponde à « ${a.container} » (A).`,
    '-- Script généré par DB Explorer Lite : à relire avant exécution. Les suppressions sont en commentaire ;',
    '-- les options de table (moteur, jeu de caractères, tablespace) et les commentaires ne sont pas comparés.',
  ];
  if (create.length) {
    sections.push('', '-- ===== Tables à créer', create.join('\n\n'));
  }
  if (alter.length) {
    sections.push('', '-- ===== Tables à modifier', alter.join('\n\n'));
  }
  if (manual.length) {
    sections.push('', '-- ===== À traiter à la main', manual.join('\n'));
  }
  if (drops.length) {
    sections.push('', '-- ===== Objets en trop dans B (suppression non exécutée)', drops.join('\n'));
  }
  if (items.length === 0) {
    sections.push('', '-- Aucune différence.');
  }
  return { items, script: sections.join('\n') + '\n' };
}

export const MAX_COMPARE_TABLES = 400;

/** Lit la structure de toutes les tables d'une base / d'un schéma (par petits groupes en parallèle). */
export async function takeSnapshot(
  driver: { type: DbType; listTables(c: string): Promise<{ name: string; isView: boolean }[]>; describeTable(c: string, t: string): Promise<TableStructure> },
  container: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Snapshot> {
  const list = await driver.listTables(container);
  if (list.length > MAX_COMPARE_TABLES) {
    throw new Error(`Trop de tables à comparer (${list.length}, maximum ${MAX_COMPARE_TABLES}).`);
  }
  const tables = new Map<string, TableStructure>();
  let done = 0;
  for (let i = 0; i < list.length; i += 6) {
    await Promise.all(
      list.slice(i, i + 6).map(async (t) => {
        tables.set(t.name, await driver.describeTable(container, t.name));
        onProgress?.(++done, list.length);
      }),
    );
  }
  return { dbType: driver.type, container, tables };
}

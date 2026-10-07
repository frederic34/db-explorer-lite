// Import et export de connexions : fichier JSON de l'extension, ~/.pgpass, ~/.pg_service.conf, ~/.my.cnf.
// Fonctions pures (aucune dépendance à VS Code) : tout ce qui vient d'un fichier est traité comme non fiable.
import { ConnectionConfig, DbType, SshConfig } from './types';
import { t } from './i18n';

/** Connexion sans identifiant (il est attribué à l'enregistrement) et son mot de passe éventuel. */
export type NewConnection = Omit<ConnectionConfig, 'id'>;
export interface Imported {
  config: NewConnection;
  /** Fourni par le fichier source (~/.pgpass, ~/.my.cnf…) ; jamais présent dans un export de l'extension. */
  password?: string;
}
export interface ImportResult {
  items: Imported[];
  /** Entrées ignorées, avec la raison (à afficher à l'utilisateur). */
  skipped: string[];
}

export const EXPORT_FORMAT = 'db-explorer-lite/connections';

const MAX_TEXT = 1024;
const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 255): string | undefined =>
  typeof v === 'string' && v.length <= max && !/[\0\r\n]/.test(v) ? v : undefined;
const port = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
};

// ---------------------------------------------------------------------------------------------
// Export / import JSON de l'extension
// ---------------------------------------------------------------------------------------------

/** Contenu d'un fichier d'export : les connexions SANS identifiant ni aucun mot de passe. */
export function serializeConnections(connections: ConnectionConfig[]): string {
  const clean = connections.map((c) => {
    const { id: _id, ...rest } = c;
    void _id;
    return rest;
  });
  return JSON.stringify({ format: EXPORT_FORMAT, version: 1, connections: clean }, null, 2) + '\n';
}

/** Reconstruit une connexion en ne gardant que des champs connus et valides (jamais l'objet d'origine). */
export function sanitizeConnection(raw: unknown): { config: NewConnection } | { error: string } {
  if (!isPlain(raw)) {
    return { error: t('entrée qui n\'est pas un objet', 'entry is not an object') };
  }
  const type = raw.type;
  if (type !== 'mysql' && type !== 'postgres' && type !== 'sqlite') {
    return { error: t(`type de base inconnu (${String(type).slice(0, 30)})`, `unknown database type (${String(type).slice(0, 30)})`) };
  }
  const name = text(raw.name, 200)?.trim();
  if (!name) {
    return { error: t('nom manquant ou invalide', 'missing or invalid name') };
  }
  const group = raw.group === undefined ? undefined : text(raw.group, 100)?.trim();
  if (raw.group !== undefined && !group && raw.group !== '') {
    return { error: t(`« ${name} » : groupe invalide`, `“${name}”: invalid group`) };
  }
  const flags = {
    readOnly: raw.readOnly === true || undefined,
    production: raw.production === true || undefined,
    group: group || undefined,
  };

  if (type === 'sqlite') {
    const file = text(raw.file, MAX_TEXT)?.trim();
    if (!file) {
      return { error: t(`« ${name} » : fichier SQLite manquant`, `“${name}”: missing SQLite file`) };
    }
    return { config: { name, type, host: '', port: 0, user: '', file, readOnly: true, group: flags.group } };
  }

  const host = text(raw.host)?.trim();
  const p = port(raw.port);
  const user = text(raw.user)?.trim();
  if (!host || p === undefined || !user) {
    return { error: t(`« ${name} » : hôte, port ou utilisateur manquant ou invalide`, `“${name}”: missing or invalid host, port or user`) };
  }
  const database = raw.database === undefined || raw.database === '' ? undefined : text(raw.database);
  if (raw.database !== undefined && raw.database !== '' && database === undefined) {
    return { error: t(`« ${name} » : base de données invalide`, `“${name}”: invalid database`) };
  }
  if (type === 'postgres' && !database) {
    return { error: t(`« ${name} » : base de données obligatoire pour PostgreSQL`, `“${name}”: database is required for PostgreSQL`) };
  }

  let ssh: SshConfig | undefined;
  if (raw.ssh !== undefined && raw.ssh !== null) {
    const s = raw.ssh;
    if (!isPlain(s)) {
      return { error: t(`« ${name} » : tunnel SSH invalide`, `“${name}”: invalid SSH tunnel`) };
    }
    const sshHost = text(s.host)?.trim();
    const sshPort = port(s.port);
    const sshUser = text(s.user)?.trim();
    const authMethod = s.authMethod;
    if (!sshHost || sshPort === undefined || !sshUser || (authMethod !== 'password' && authMethod !== 'key' && authMethod !== 'agent')) {
      return { error: t(`« ${name} » : tunnel SSH incomplet ou invalide`, `“${name}”: incomplete or invalid SSH tunnel`) };
    }
    const keyPath = authMethod === 'key' ? text(s.keyPath, MAX_TEXT)?.trim() : undefined;
    if (authMethod === 'key' && !keyPath) {
      return { error: t(`« ${name} » : clé privée SSH manquante`, `“${name}”: missing SSH private key`) };
    }
    ssh = { host: sshHost, port: sshPort, user: sshUser, authMethod, keyPath };
  }

  return {
    config: { name, type: type as DbType, host, port: p, user, database, ssl: raw.ssl === true, ...flags, ssh },
  };
}

/** Lit un fichier d'export JSON (ou une simple liste de connexions). */
export function parseConnectionsFile(content: string): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw new Error(t("Ce fichier n'est pas du JSON valide.", 'This file is not valid JSON.'));
  }
  const list = Array.isArray(data) ? data : isPlain(data) && Array.isArray(data.connections) ? data.connections : undefined;
  if (!list) {
    throw new Error(t("Format non reconnu : il faut un fichier exporté par DB Explorer Lite (clé « connections »).", 'Unrecognized format: expected a file exported by DB Explorer Lite (“connections” key).'));
  }
  if (list.length > 1000) {
    throw new Error(t('Trop de connexions dans ce fichier (1000 au maximum).', 'Too many connections in this file (1000 maximum).'));
  }
  const out: ImportResult = { items: [], skipped: [] };
  list.forEach((raw, i) => {
    const r = sanitizeConnection(raw);
    if ('error' in r) {
      out.skipped.push(t(`entrée ${i + 1} : ${r.error}`, `entry ${i + 1}: ${r.error}`));
    } else {
      out.items.push({ config: r.config });
    }
  });
  return out;
}

/** Deux connexions qui visent la même base sont des doublons. */
export function connectionKey(c: Pick<ConnectionConfig, 'type' | 'host' | 'port' | 'user' | 'database' | 'file'>): string {
  return c.type === 'sqlite'
    ? `sqlite|${c.file ?? ''}`
    : [c.type, c.host.toLowerCase(), c.port, c.user, c.database ?? ''].join('|');
}

// ---------------------------------------------------------------------------------------------
// ~/.pgpass
// ---------------------------------------------------------------------------------------------

/** Découpe une ligne « hôte:port:base:utilisateur:mot de passe » (« \: » et « \\ » échappés). */
function splitPgpass(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
    } else if (c === ':' && fields.length < 4) {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

export function parsePgpass(content: string): ImportResult {
  const out: ImportResult = { items: [], skipped: [] };
  content.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      return;
    }
    const f = splitPgpass(line);
    if (f.length !== 5) {
      out.skipped.push(t(`ligne ${i + 1} : format invalide`, `line ${i + 1}: invalid format`));
      return;
    }
    const [host, portText, database, user, password] = f;
    if ([host, portText, database, user].includes('*')) {
      out.skipped.push(t(`ligne ${i + 1} : contient un joker (*), on ne peut pas en faire une connexion`, `line ${i + 1}: contains a wildcard (*), cannot be turned into a connection`));
      return;
    }
    const p = port(portText);
    if (!host || p === undefined || !database || !user) {
      out.skipped.push(t(`ligne ${i + 1} : hôte, port, base ou utilisateur invalide`, `line ${i + 1}: invalid host, port, database or user`));
      return;
    }
    out.items.push({ config: { name: `${user}@${host}/${database}`, type: 'postgres', host, port: p, user, database }, password });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Fichiers INI : ~/.pg_service.conf et ~/.my.cnf
// ---------------------------------------------------------------------------------------------

/** Valeur d'un fichier INI : guillemets simples ou doubles, commentaire « # » ou « ; » en fin de ligne si non quotée. */
function iniValue(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    let out = '';
    for (let i = 1; i < v.length; i++) {
      if (v[i] === '\\' && i + 1 < v.length) {
        out += v[++i];
      } else if (v[i] === q) {
        return out;
      } else {
        out += v[i];
      }
    }
    return out;
  }
  return v.replace(/\s+[#;].*$/, '');
}

function parseIni(content: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = sections.get(header[1]) ?? new Map();
      sections.set(header[1], current);
      continue;
    }
    const eq = line.indexOf('=');
    if (!current) {
      continue;
    }
    const key = (eq < 0 ? line : line.slice(0, eq)).trim().toLowerCase().replace(/-/g, '_');
    current.set(key, eq < 0 ? '' : iniValue(line.slice(eq + 1)));
  }
  return sections;
}

export function parsePgService(content: string): ImportResult {
  const out: ImportResult = { items: [], skipped: [] };
  for (const [name, kv] of parseIni(content)) {
    const host = kv.get('host') || kv.get('hostaddr') || 'localhost';
    const p = kv.has('port') ? port(kv.get('port')) : 5432;
    const database = kv.get('dbname');
    const user = kv.get('user');
    if (host.startsWith('/')) {
      out.skipped.push(t(`service « ${name} » : connexion par socket Unix non prise en charge`, `service “${name}”: Unix socket connections are not supported`));
    } else if (p === undefined || !database || !user) {
      out.skipped.push(t(`service « ${name} » : il manque dbname, user ou le port est invalide`, `service “${name}”: dbname or user is missing, or the port is invalid`));
    } else {
      const ssl = /^(require|verify-ca|verify-full)$/i.test(kv.get('sslmode') ?? '');
      out.items.push({
        config: { name, type: 'postgres', host, port: p, user, database, ssl: ssl || undefined },
        password: kv.get('password') || undefined,
      });
    }
  }
  return out;
}

export function parseMyCnf(content: string): ImportResult {
  const out: ImportResult = { items: [], skipped: [] };
  const sections = parseIni(content);
  // « [mysql] » complète et remplace « [client] » ; « [client-mariadb] » etc. sont ignorés.
  const kv = new Map<string, string>();
  for (const name of ['client', 'mysql']) {
    for (const [k, v] of sections.get(name) ?? []) {
      kv.set(k, v);
    }
  }
  if (!kv.has('host') && !kv.has('user') && !kv.has('port') && !kv.has('socket')) {
    out.skipped.push(t('aucune section [client] ou [mysql] avec un hôte ou un utilisateur', 'no [client] or [mysql] section with a host or user'));
    return out;
  }
  const host = kv.get('host') || 'localhost';
  const p = kv.has('port') ? port(kv.get('port')) : 3306;
  const user = kv.get('user') || 'root';
  if (p === undefined) {
    out.skipped.push(t('port invalide', 'invalid port'));
    return out;
  }
  if (kv.has('socket') && !kv.has('host')) {
    out.skipped.push(t('connexion par socket Unix (socket=) non prise en charge : indiquez un hôte TCP', 'Unix socket connection (socket=) is not supported: specify a TCP host'));
    return out;
  }
  const database = kv.get('database') || undefined;
  const ssl = kv.has('ssl') ? !/^(0|false|off|disabled?)$/i.test(kv.get('ssl') ?? '1') || undefined : undefined;
  out.items.push({
    config: { name: `${user}@${host}${database ? '/' + database : ''}`, type: 'mysql', host, port: p, user, database, ssl: ssl || undefined },
    password: kv.get('password') || undefined,
  });
  return out;
}

/** Fichiers de configuration que l'on sait lire, avec leur analyseur. */
export const SOURCES = {
  pgpass: { label: '~/.pgpass', parse: parsePgpass },
  pgservice: { label: '~/.pg_service.conf', parse: parsePgService },
  mycnf: { label: '~/.my.cnf', parse: parseMyCnf },
} as const;
export type SourceKind = keyof typeof SOURCES;

/** Devine le type d'un fichier choisi à la main, d'après son nom puis son contenu. */
export function guessSource(fileName: string, content: string): SourceKind | 'json' | undefined {
  const base = fileName.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (base.endsWith('.json')) {
    return 'json';
  }
  if (base === '.pgpass' || base === 'pgpass.conf') {
    return 'pgpass';
  }
  if (base.includes('pg_service')) {
    return 'pgservice';
  }
  if (base.includes('my.cnf') || base.endsWith('.cnf')) {
    return 'mycnf';
  }
  const first = content.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'))?.trim() ?? '';
  if (first.startsWith('{') || first.startsWith('[{')) {
    return 'json';
  }
  if (/^[^\s:\[][^\s]*:\S*:[^:]*:[^:]*:/.test(first)) {
    return 'pgpass';
  }
  return undefined;
}

/** Emplacements habituels de ces fichiers (variables d'environnement PostgreSQL comprises). */
export function defaultSourcePaths(
  env: Record<string, string | undefined>,
  home: string,
  platform: string,
): { kind: SourceKind; path: string }[] {
  const win = platform === 'win32';
  const sep = win ? '\\' : '/';
  const join = (...p: string[]) => p.join(sep);
  const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
  return [
    { kind: 'pgpass', path: env.PGPASSFILE || (win ? join(appData, 'postgresql', 'pgpass.conf') : join(home, '.pgpass')) },
    { kind: 'pgservice', path: env.PGSERVICEFILE || join(home, '.pg_service.conf') },
    { kind: 'mycnf', path: join(home, win ? 'my.ini' : '.my.cnf') },
  ];
}

export interface PlannedImport extends Imported {
  /** Une connexion identique existe déjà : décochée par défaut. */
  duplicate: boolean;
  /** Ligne lisible pour la liste de choix. */
  label: string;
  detail: string;
}

/** Présente les entrées à importer en repérant celles qui existent déjà (ou qui se répètent dans le fichier). */
export function planImport(items: Imported[], existing: ConnectionConfig[]): PlannedImport[] {
  const seen = new Set(existing.map(connectionKey));
  return items.map((it) => {
    const key = connectionKey(it.config);
    const duplicate = seen.has(key);
    seen.add(key);
    const c = it.config;
    const target = c.type === 'sqlite' ? (c.file ?? '') : `${c.host}:${c.port}${c.database ? '/' + c.database : ''} · ${c.user}`;
    const kind = c.type === 'mysql' ? 'MySQL' : c.type === 'postgres' ? 'PostgreSQL' : 'SQLite';
    return {
      ...it,
      duplicate,
      label: c.name,
      detail: `${kind} · ${target}${c.group ? t(` · groupe ${c.group}`, ` · group ${c.group}`) : ''}${it.password ? t(' · mot de passe du fichier', ' · password from file') : ''}${duplicate ? t(' · déjà présente', ' · already exists') : ''}`,
    };
  });
}

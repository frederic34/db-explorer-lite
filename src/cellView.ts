import { DbType } from './types';
import { quoteIdent } from './util';

export const MAX_BINARY_VIEW = 10 * 1024 * 1024;

/** Type d'image reconnu à ses premiers octets (jamais au nom ni au type de la colonne). */
export function sniffImage(b: Buffer): { mime: string; label: string } | undefined {
  const starts = (...bytes: number[]) => bytes.every((x, i) => b[i] === x);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) { return { mime: 'image/png', label: 'PNG' }; }
  if (starts(0xff, 0xd8, 0xff)) { return { mime: 'image/jpeg', label: 'JPEG' }; }
  if (starts(0x47, 0x49, 0x46, 0x38)) { return { mime: 'image/gif', label: 'GIF' }; }
  if (starts(0x42, 0x4d) && b.length > 14) { return { mime: 'image/bmp', label: 'BMP' }; }
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', label: 'WebP' };
  }
  return undefined;
}

/** Taille annoncée par l'affichage d'une cellule binaire (`<binaire N octets>` ou `0x…`), sinon undefined. */
export function binarySize(shown: string): number | undefined {
  const m = /^<binaire (\d+) octets>$/.exec(shown);
  if (m) {
    return Number(m[1]);
  }
  return /^0x([0-9a-fA-F]{2})*$/.test(shown) ? (shown.length - 2) / 2 : undefined;
}

/** Lecture du contenu binaire en hexadécimal, par la clé primaire (aucune modification des pilotes). */
export function hexSelect(
  dbType: DbType,
  container: string,
  table: string,
  column: string,
  pkNames: string[],
): string {
  const q = (n: string) => quoteIdent(dbType, n);
  const expr = dbType === 'postgres' ? `encode(${q(column)}, 'hex')` : `HEX(${q(column)})`;
  const where = pkNames.map((n, k) => `${q(n)} = ${dbType === 'postgres' ? `$${k + 1}` : '?'}`).join(' AND ');
  const from = dbType === 'sqlite' ? q(table) : `${q(container)}.${q(table)}`;
  return `SELECT ${expr} FROM ${from} WHERE ${where}`;
}

export function hexDump(b: Buffer, max = 4096): string {
  const lines: string[] = [];
  const n = Math.min(b.length, max);
  for (let i = 0; i < n; i += 16) {
    const chunk = b.subarray(i, Math.min(i + 16, n));
    const hex = [...chunk].map((x) => x.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const txt = [...chunk].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  ${txt}`);
  }
  if (b.length > n) {
    lines.push(`… ${b.length - n} octets de plus`);
  }
  return lines.join('\n') + '\n';
}

/** Cellule entière = une adresse http(s) : cliquable. */
export function httpUrl(v: string | null): string | undefined {
  if (v === null || v.length > 2000 || /\s/.test(v) || !/^https?:\/\//i.test(v)) {
    return undefined;
  }
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Texte à montrer pour une valeur longue : JSON indenté s'il en est un. */
export function prettyValue(v: string): { text: string; language: string } {
  const t = v.trim();
  if (/^[[{]/.test(t)) {
    try {
      return { text: JSON.stringify(JSON.parse(t), null, 2) + '\n', language: 'json' };
    } catch {
      /* texte ordinaire */
    }
  }
  return { text: v, language: /^\s*</.test(v) ? 'xml' : 'plaintext' };
}

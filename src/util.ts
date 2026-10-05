import { DbType } from './types';

/** Message d'erreur lisible, y compris pour les erreurs réseau au message vide. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (err.message) {
      return code && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
    }
    return code || err.name;
  }
  return String(err);
}

/** Met un identifiant (base, schéma, table) entre guillemets selon le SGBD. */
export function quoteIdent(type: DbType, name: string): string {
  return type === 'mysql'
    ? '`' + name.replace(/`/g, '``') + '`'
    : '"' + name.replace(/"/g, '""') + '"';
}

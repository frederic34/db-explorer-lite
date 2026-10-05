import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { ConnectionConfig, DbType } from './types';

export interface WizardResult {
  config: ConnectionConfig;
  /** undefined = inchangé (modification sans nouveau mot de passe). */
  password: string | undefined;
}

/**
 * Assistant de création / modification d'une connexion (suite de saisies).
 * Retourne undefined si l'utilisateur annule (Échap) à n'importe quelle étape.
 */
export async function promptConnection(existing?: ConnectionConfig): Promise<WizardResult | undefined> {
  const editing = existing !== undefined;
  const title = editing ? 'Modifier la connexion' : 'Nouvelle connexion';

  let type: DbType | undefined = existing?.type;
  if (!type) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'MySQL / MariaDB', description: 'port par défaut 3306', value: 'mysql' as DbType },
        { label: 'PostgreSQL', description: 'port par défaut 5432', value: 'postgres' as DbType },
      ],
      { title, placeHolder: 'Type de base de données', ignoreFocusOut: true },
    );
    if (!pick) {
      return undefined;
    }
    type = pick.value;
  }

  const host = await vscode.window.showInputBox({
    title,
    prompt: 'Hôte (nom ou adresse IP du serveur)',
    value: existing?.host ?? 'localhost',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Champ obligatoire'),
  });
  if (host === undefined) {
    return undefined;
  }

  const portText = await vscode.window.showInputBox({
    title,
    prompt: 'Port',
    value: String(existing?.port ?? (type === 'mysql' ? 3306 : 5432)),
    ignoreFocusOut: true,
    validateInput: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 65535 ? undefined : 'Port invalide (1 à 65535)';
    },
  });
  if (portText === undefined) {
    return undefined;
  }

  const user = await vscode.window.showInputBox({
    title,
    prompt: "Nom d'utilisateur",
    value: existing?.user ?? (type === 'mysql' ? 'root' : 'postgres'),
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Champ obligatoire'),
  });
  if (user === undefined) {
    return undefined;
  }

  const passwordInput = await vscode.window.showInputBox({
    title,
    prompt: editing
      ? 'Mot de passe (laisser vide pour conserver l\'actuel)'
      : 'Mot de passe (peut être vide)',
    password: true,
    ignoreFocusOut: true,
  });
  if (passwordInput === undefined) {
    return undefined;
  }

  const database = await vscode.window.showInputBox({
    title,
    prompt:
      type === 'mysql'
        ? 'Base de données (laisser vide pour lister toutes les bases)'
        : 'Base de données',
    value: existing?.database ?? (type === 'postgres' ? 'postgres' : ''),
    ignoreFocusOut: true,
    validateInput: (v) => (type === 'postgres' && !v.trim() ? 'Champ obligatoire' : undefined),
  });
  if (database === undefined) {
    return undefined;
  }

  const ssl = await vscode.window.showQuickPick(
    [
      { label: 'Non', value: false },
      { label: 'Oui (SSL/TLS)', value: true },
    ],
    {
      title,
      placeHolder: 'Chiffrer la connexion (SSL/TLS) ?',
      ignoreFocusOut: true,
    },
  );
  if (!ssl) {
    return undefined;
  }

  const defaultName = `${user.trim()}@${host.trim()}${database.trim() ? '/' + database.trim() : ''}`;
  const name = await vscode.window.showInputBox({
    title,
    prompt: 'Nom affiché de la connexion',
    value: existing?.name ?? defaultName,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Champ obligatoire'),
  });
  if (name === undefined) {
    return undefined;
  }

  return {
    config: {
      id: existing?.id ?? randomUUID(),
      name: name.trim(),
      type,
      host: host.trim(),
      port: Number(portText),
      user: user.trim(),
      database: database.trim() || undefined,
      ssl: ssl.value,
    },
    password: editing && passwordInput === '' ? undefined : passwordInput,
  };
}

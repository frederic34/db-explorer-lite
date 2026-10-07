import * as vscode from 'vscode';

/**
 * Libellés bilingues : chaque appel porte le français ET l'anglais, côte à côte
 * (`t('Texte', 'Text')`), pour qu'aucun dictionnaire ne puisse dériver du code.
 * La langue suit celle de VS Code ; tout ce qui n'est pas « fr » est affiché en anglais.
 */
export function isFrench(): boolean {
  const forced = process.env.DBX_LANG;
  if (forced) {
    return forced.toLowerCase().startsWith('fr');
  }
  const lang = (vscode.env && vscode.env.language) || 'en';
  return lang.toLowerCase().startsWith('fr');
}

export function t(fr: string, en: string): string {
  return isFrench() ? fr : en;
}

/** Préambule des webviews : définit `T(fr, en)` côté page. */
export function webviewI18n(): string {
  return `var FR=${isFrench() ? 'true' : 'false'};function T(fr,en){return FR?fr:en;}`;
}

import { DbType } from './types';
import { scanSql, Statement } from './sqlGuard';

/**
 * Instruction sous le curseur : celle qui contient `offset` ; juste après son « ; » on reste sur elle,
 * dans les lignes vides qui suivent on prend la suivante, et après la dernière on retombe sur la dernière.
 */
export function statementAt(sql: string, offset: number, dbType: DbType): Statement | undefined {
  const { statements } = scanSql(sql, dbType);
  if (statements.length === 0) {
    return undefined;
  }
  for (const st of statements) {
    if (offset >= st.from && offset <= st.to + 1) {
      return st;
    }
  }
  const next = statements.find((st) => st.from > offset);
  return next ?? statements[statements.length - 1];
}

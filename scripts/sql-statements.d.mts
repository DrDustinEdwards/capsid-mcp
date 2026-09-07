// Types for the SQL walk, so vitest.config.ts type-checks under
// test-integration/tsconfig.json. The runtime is scripts/sql-statements.mjs.
// An index signature as well as the two fields, because these cross into
// miniflare as a JSON binding and miniflare requires an index-signature-bearing
// shape. Both readers narrow to file and sql.
export interface ExtractedStatement {
  [key: string]: string;
  file: string;
  sql: string;
}
export function extractStatements(srcDir: string): {
  statements: ExtractedStatement[];
  skipped: ExtractedStatement[];
};
export function readStatements(statements: ExtractedStatement[]): ExtractedStatement[];
export const HOT_TABLES: string[];

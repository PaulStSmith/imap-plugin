import sql from "mssql";

let poolPromise: Promise<sql.ConnectionPool> | undefined;

export function hasSqlConnectionString(): boolean {
  return Boolean(process.env.IMAP_PLUGIN_SQL_CONNECTION_STRING?.trim());
}

export function sqlConnectionString(): string {
  const value = process.env.IMAP_PLUGIN_SQL_CONNECTION_STRING;
  if (!value) {
    throw new Error("IMAP_PLUGIN_SQL_CONNECTION_STRING is required for SQL-backed account or secret storage.");
  }

  return value;
}

export async function sqlPool(): Promise<sql.ConnectionPool> {
  poolPromise ??= new sql.ConnectionPool(sqlConnectionString()).connect();
  return poolPromise;
}

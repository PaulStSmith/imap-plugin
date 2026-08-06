import sql from "mssql";

let poolPromise: Promise<sql.ConnectionPool> | undefined;

export interface SqlHealthStatus {
  configured: boolean;
  ok: boolean;
  status: "not_configured" | "connected" | "error";
  server?: string;
  database?: string;
  error?: string;
}

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

function safeSqlError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
      .replace(/Password=([^;]+)/gi, "Password=<redacted>")
      .replace(/Pwd=([^;]+)/gi, "Pwd=<redacted>");
  }

  return "SQL connectivity check failed.";
}

export async function checkSqlHealth(): Promise<SqlHealthStatus> {
  if (!hasSqlConnectionString()) {
    return {
      configured: false,
      ok: false,
      status: "not_configured"
    };
  }

  try {
    const connection = await sqlPool();
    const result = await connection.request().query<{ serverName: string; databaseName: string }>(`
SELECT
  @@SERVERNAME AS serverName,
  DB_NAME() AS databaseName;
`);
    const row = result.recordset[0];
    return {
      configured: true,
      ok: true,
      status: "connected",
      server: row?.serverName,
      database: row?.databaseName
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      status: "error",
      error: safeSqlError(error)
    };
  }
}

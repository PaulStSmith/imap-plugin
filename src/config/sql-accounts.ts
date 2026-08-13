import sql from "mssql";
import { sqlPool } from "./sql.js";
import { AccountProfile, CredentialProviderKind } from "../types.js";

type AccountRow = {
  id: string;
  email: string | null;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  credentialProvider: CredentialProviderKind;
  credentialRef: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean | null;
  smtpUsername: string | null;
};

let schemaPromise: Promise<void> | undefined;

async function ensureSchema(): Promise<void> {
  schemaPromise ??= (async () => {
    const connection = await sqlPool();
    await connection.request().query(`
IF OBJECT_ID(N'dbo.AccountProfiles', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.AccountProfiles
  (
    Id NVARCHAR(128) NOT NULL CONSTRAINT PK_AccountProfiles PRIMARY KEY,
    Email NVARCHAR(320) NULL,
    Host NVARCHAR(255) NOT NULL,
    Port INT NOT NULL,
    Secure BIT NOT NULL,
    Username NVARCHAR(320) NOT NULL,
    CredentialProvider NVARCHAR(64) NOT NULL,
    CredentialRef NVARCHAR(2048) NULL,
    SmtpHost NVARCHAR(255) NULL,
    SmtpPort INT NULL,
    SmtpSecure BIT NULL,
    SmtpUsername NVARCHAR(320) NULL,
    CreatedAtUtc DATETIME2(3) NOT NULL CONSTRAINT DF_AccountProfiles_CreatedAtUtc DEFAULT SYSUTCDATETIME(),
    UpdatedAtUtc DATETIME2(3) NOT NULL CONSTRAINT DF_AccountProfiles_UpdatedAtUtc DEFAULT SYSUTCDATETIME()
  );
END;
`);
  })().catch((error: unknown) => {
    // Do not permanently poison this worker after a transient SQL failure.
    // A later MCP request should be able to retry schema initialization.
    schemaPromise = undefined;
    throw error;
  });

  return schemaPromise;
}

function fromRow(row: AccountRow): AccountProfile {
  return {
    id: row.id,
    email: row.email ?? undefined,
    host: row.host,
    port: row.port,
    secure: Boolean(row.secure),
    username: row.username,
    credentialProvider: row.credentialProvider,
    credentialRef: row.credentialRef ?? undefined,
    smtpHost: row.smtpHost ?? undefined,
    smtpPort: row.smtpPort ?? undefined,
    smtpSecure: row.smtpSecure === null ? undefined : Boolean(row.smtpSecure),
    smtpUsername: row.smtpUsername ?? undefined
  };
}

function bindAccount(request: sql.Request, account: AccountProfile): sql.Request {
  return request
    .input("id", sql.NVarChar(128), account.id)
    .input("email", sql.NVarChar(320), account.email ?? null)
    .input("host", sql.NVarChar(255), account.host)
    .input("port", sql.Int, account.port)
    .input("secure", sql.Bit, account.secure)
    .input("username", sql.NVarChar(320), account.username)
    .input("credentialProvider", sql.NVarChar(64), account.credentialProvider)
    .input("credentialRef", sql.NVarChar(2048), account.credentialRef ?? null)
    .input("smtpHost", sql.NVarChar(255), account.smtpHost ?? null)
    .input("smtpPort", sql.Int, account.smtpPort ?? null)
    .input("smtpSecure", sql.Bit, account.smtpSecure ?? null)
    .input("smtpUsername", sql.NVarChar(320), account.smtpUsername ?? null);
}

export async function readSqlAccounts(): Promise<AccountProfile[]> {
  const connection = await sqlPool();
  try {
    return await selectAccounts(connection);
  } catch (error) {
    if ((error as { number?: number }).number !== 208) {
      throw error;
    }

    await ensureSchema();
    return selectAccounts(connection);
  }
}

async function selectAccounts(connection: sql.ConnectionPool): Promise<AccountProfile[]> {
  const result = await connection.request().query<AccountRow>(`
SELECT
  Id AS id,
  Email AS email,
  Host AS host,
  Port AS port,
  Secure AS secure,
  Username AS username,
  CredentialProvider AS credentialProvider,
  CredentialRef AS credentialRef,
  SmtpHost AS smtpHost,
  SmtpPort AS smtpPort,
  SmtpSecure AS smtpSecure,
  SmtpUsername AS smtpUsername
FROM dbo.AccountProfiles
ORDER BY Id;
`);

  return result.recordset.map(fromRow);
}

export async function writeSqlAccounts(accounts: AccountProfile[]): Promise<void> {
  await ensureSchema();
  const connection = await sqlPool();
  const transaction = new sql.Transaction(connection);
  await transaction.begin();

  try {
    await new sql.Request(transaction).query("DELETE FROM dbo.AccountProfiles;");
    for (const account of accounts) {
      await insertAccount(new sql.Request(transaction), account);
    }

    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function upsertSqlAccount(account: AccountProfile): Promise<AccountProfile> {
  await ensureSchema();
  const connection = await sqlPool();
  await bindAccount(connection.request(), account).query(`
MERGE dbo.AccountProfiles AS target
USING (SELECT @id AS Id) AS source
ON target.Id = source.Id
WHEN MATCHED THEN
  UPDATE SET
    Email = @email,
    Host = @host,
    Port = @port,
    Secure = @secure,
    Username = @username,
    CredentialProvider = @credentialProvider,
    CredentialRef = @credentialRef,
    SmtpHost = @smtpHost,
    SmtpPort = @smtpPort,
    SmtpSecure = @smtpSecure,
    SmtpUsername = @smtpUsername,
    UpdatedAtUtc = SYSUTCDATETIME()
WHEN NOT MATCHED THEN
  INSERT
    (Id, Email, Host, Port, Secure, Username, CredentialProvider, CredentialRef, SmtpHost, SmtpPort, SmtpSecure, SmtpUsername)
  VALUES
    (@id, @email, @host, @port, @secure, @username, @credentialProvider, @credentialRef, @smtpHost, @smtpPort, @smtpSecure, @smtpUsername);
`);

  return account;
}

export async function removeSqlAccount(accountId: string): Promise<boolean> {
  await ensureSchema();
  const connection = await sqlPool();
  const result = await connection.request()
    .input("id", sql.NVarChar(128), accountId)
    .query("DELETE FROM dbo.AccountProfiles WHERE Id = @id;");

  return (result.rowsAffected[0] ?? 0) > 0;
}

async function insertAccount(request: sql.Request, account: AccountProfile): Promise<void> {
  await bindAccount(request, account).query(`
INSERT INTO dbo.AccountProfiles
  (Id, Email, Host, Port, Secure, Username, CredentialProvider, CredentialRef, SmtpHost, SmtpPort, SmtpSecure, SmtpUsername)
VALUES
  (@id, @email, @host, @port, @secure, @username, @credentialProvider, @credentialRef, @smtpHost, @smtpPort, @smtpSecure, @smtpUsername);
`);
}

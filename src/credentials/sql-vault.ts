import sql from "mssql";
import { sqlPool } from "../config/sql.js";
import { AccountProfile, MailboxCredential } from "../types.js";
import { CredentialProvider } from "./provider.js";

type SqlVaultPayload = {
  kind: "password";
  username?: string;
  password: string;
};

let schemaPromise: Promise<void> | undefined;

export function sqlVaultCredentialRef(account: AccountProfile): string {
  return account.credentialRef ?? `sql-vault://${account.id}`;
}

function secretNameFromRef(account: AccountProfile): string {
  const ref = sqlVaultCredentialRef(account);
  if (!ref.startsWith("sql-vault://")) {
    throw new Error(`Unsupported SQL vault credential reference for account "${account.id}".`);
  }

  const name = ref.slice("sql-vault://".length);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid SQL vault secret name for account "${account.id}".`);
  }

  return name;
}

async function ensureSchema(): Promise<void> {
  schemaPromise ??= (async () => {
    const connection = await sqlPool();
    await connection.request().query(`
IF OBJECT_ID(N'dbo.MailboxCredentials', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.MailboxCredentials
  (
    SecretName NVARCHAR(128) NOT NULL CONSTRAINT PK_MailboxCredentials PRIMARY KEY,
    SecretValueJson NVARCHAR(MAX) NOT NULL,
    Version UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_MailboxCredentials_Version DEFAULT NEWID(),
    CreatedAtUtc DATETIME2(3) NOT NULL CONSTRAINT DF_MailboxCredentials_CreatedAtUtc DEFAULT SYSUTCDATETIME(),
    UpdatedAtUtc DATETIME2(3) NOT NULL CONSTRAINT DF_MailboxCredentials_UpdatedAtUtc DEFAULT SYSUTCDATETIME()
  );
END;
`);
  })();

  return schemaPromise;
}

function parsePayload(account: AccountProfile, value: string): SqlVaultPayload {
  const parsed = JSON.parse(value) as Partial<SqlVaultPayload>;
  if (parsed.kind !== "password" || typeof parsed.password !== "string" || !parsed.password) {
    throw new Error(`SQL vault secret for account "${account.id}" is not a password credential.`);
  }

  return {
    kind: "password",
    username: typeof parsed.username === "string" ? parsed.username : undefined,
    password: parsed.password
  };
}

export class SqlVaultCredentialProvider implements CredentialProvider {
  async get(account: AccountProfile): Promise<MailboxCredential> {
    await ensureSchema();
    const connection = await sqlPool();
    const result = await connection.request()
      .input("secretName", sql.NVarChar(128), secretNameFromRef(account))
      .query<{ secretValueJson: string }>(`
SELECT SecretValueJson AS secretValueJson
FROM dbo.MailboxCredentials
WHERE SecretName = @secretName;
`);

    const row = result.recordset[0];
    if (!row) {
      throw new Error(`No SQL vault secret found for account "${account.id}".`);
    }

    const payload = parsePayload(account, row.secretValueJson);
    return {
      username: payload.username ?? account.username,
      password: payload.password
    };
  }

  async set(account: AccountProfile, password: string): Promise<void> {
    await ensureSchema();
    const connection = await sqlPool();
    const payload: SqlVaultPayload = {
      kind: "password",
      username: account.username,
      password
    };

    await connection.request()
      .input("secretName", sql.NVarChar(128), secretNameFromRef(account))
      .input("secretValueJson", sql.NVarChar(sql.MAX), JSON.stringify(payload))
      .query(`
MERGE dbo.MailboxCredentials AS target
USING (SELECT @secretName AS SecretName) AS source
ON target.SecretName = source.SecretName
WHEN MATCHED THEN
  UPDATE SET
    SecretValueJson = @secretValueJson,
    Version = NEWID(),
    UpdatedAtUtc = SYSUTCDATETIME()
WHEN NOT MATCHED THEN
  INSERT (SecretName, SecretValueJson)
  VALUES (@secretName, @secretValueJson);
`);
  }

  async delete(account: AccountProfile): Promise<void> {
    await ensureSchema();
    const connection = await sqlPool();
    await connection.request()
      .input("secretName", sql.NVarChar(128), secretNameFromRef(account))
      .query("DELETE FROM dbo.MailboxCredentials WHERE SecretName = @secretName;");
  }
}

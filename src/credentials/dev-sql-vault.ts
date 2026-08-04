import { createHash } from "node:crypto";
import sql from "mssql";
import { sqlPool } from "../config/sql.js";
import { AccountProfile, MailboxCredential } from "../types.js";
import { CredentialProvider } from "./provider.js";

type DevVaultPayload = {
  kind: "password";
  username?: string;
  password: string;
};

let schemaPromise: Promise<void> | undefined;

function deterministicGuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0") + hex.slice(18, 20),
    hex.slice(20, 32)
  ].join("-");
}

function devVaultNamespaceSeed(): string {
  return process.env.IMAP_PLUGIN_DEV_VAULT_NAMESPACE_SEED ?? "imap-plugin-local-dev";
}

function devVaultUserSeed(): string {
  return process.env.IMAP_PLUGIN_DEV_VAULT_USER_ID ?? "local-dev";
}

function secretNameForAccount(account: AccountProfile): string {
  const userGuid = deterministicGuid(`${devVaultNamespaceSeed()}:user:${devVaultUserSeed()}`);
  const accountGuid = deterministicGuid(`${devVaultNamespaceSeed()}:account:${devVaultUserSeed()}:${account.id}:${account.username}`);
  return `imap-${userGuid}-${accountGuid}`;
}

export function devSqlVaultCredentialRef(account: AccountProfile): string {
  return account.credentialRef ?? `dev-kv://${secretNameForAccount(account)}`;
}

function secretNameFromRef(account: AccountProfile): string {
  const ref = devSqlVaultCredentialRef(account);
  if (!ref.startsWith("dev-kv://")) {
    throw new Error(`Unsupported dev SQL vault credential reference for account "${account.id}".`);
  }

  const name = ref.slice("dev-kv://".length);
  if (!/^[a-zA-Z0-9-]+$/.test(name)) {
    throw new Error(`Invalid dev SQL vault secret name for account "${account.id}".`);
  }

  return name;
}

async function ensureSchema(): Promise<void> {
  schemaPromise ??= (async () => {
    const connection = await sqlPool();
    await connection.request().query(`
IF OBJECT_ID(N'dbo.DevVaultSecrets', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.DevVaultSecrets
  (
    SecretName NVARCHAR(256) NOT NULL CONSTRAINT PK_DevVaultSecrets PRIMARY KEY,
    SecretValueJson NVARCHAR(MAX) NOT NULL,
    Version UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_DevVaultSecrets_Version DEFAULT NEWID(),
    CreatedAtUtc DATETIME2(3) NOT NULL CONSTRAINT DF_DevVaultSecrets_CreatedAtUtc DEFAULT SYSUTCDATETIME(),
    UpdatedAtUtc DATETIME2(3) NOT NULL CONSTRAINT DF_DevVaultSecrets_UpdatedAtUtc DEFAULT SYSUTCDATETIME()
  );
END;
`);
  })();

  return schemaPromise;
}

function parsePayload(account: AccountProfile, value: string): DevVaultPayload {
  const parsed = JSON.parse(value) as Partial<DevVaultPayload>;
  if (parsed.kind !== "password" || typeof parsed.password !== "string" || !parsed.password) {
    throw new Error(`Dev SQL vault secret for account "${account.id}" is not a password credential.`);
  }

  return {
    kind: "password",
    username: typeof parsed.username === "string" ? parsed.username : undefined,
    password: parsed.password
  };
}

export class DevSqlVaultCredentialProvider implements CredentialProvider {
  async get(account: AccountProfile): Promise<MailboxCredential> {
    await ensureSchema();
    const connection = await sqlPool();
    const secretName = secretNameFromRef(account);
    const result = await connection.request()
      .input("secretName", sql.NVarChar(256), secretName)
      .query<{ secretValueJson: string }>(`
SELECT SecretValueJson AS secretValueJson
FROM dbo.DevVaultSecrets
WHERE SecretName = @secretName;
`);

    const row = result.recordset[0];
    if (!row) {
      throw new Error(`No dev SQL vault secret found for account "${account.id}".`);
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
    const secretName = secretNameFromRef(account);
    const payload: DevVaultPayload = {
      kind: "password",
      username: account.username,
      password
    };

    await connection.request()
      .input("secretName", sql.NVarChar(256), secretName)
      .input("secretValueJson", sql.NVarChar(sql.MAX), JSON.stringify(payload))
      .query(`
MERGE dbo.DevVaultSecrets AS target
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
      .input("secretName", sql.NVarChar(256), secretNameFromRef(account))
      .query("DELETE FROM dbo.DevVaultSecrets WHERE SecretName = @secretName;");
  }
}

import sql from "mssql";
import { sqlPool } from "./sql.js";
import type { InstallationIdentity } from "./installation.js";

type InstallationRow = {
  installationId: string;
  productId: "imap-plugin";
  createdAtUtc: Date;
};

let schemaPromise: Promise<void> | undefined;

async function ensureSchema(): Promise<void> {
  schemaPromise ??= (async () => {
    const connection = await sqlPool();
    await connection.request().query(`
IF OBJECT_ID(N'dbo.PluginInstallations', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.PluginInstallations
  (
    ProductId NVARCHAR(64) NOT NULL,
    InstallationId NVARCHAR(96) NOT NULL,
    CreatedAtUtc DATETIME2(3) NOT NULL,
    UpdatedAtUtc DATETIME2(3) NOT NULL CONSTRAINT DF_PluginInstallations_UpdatedAtUtc DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_PluginInstallations PRIMARY KEY (ProductId),
    CONSTRAINT UQ_PluginInstallations_InstallationId UNIQUE (InstallationId)
  );
END;
`);
  })();

  return schemaPromise;
}

function fromRow(row: InstallationRow): InstallationIdentity {
  return {
    installationId: row.installationId,
    productId: row.productId,
    createdAt: row.createdAtUtc.toISOString()
  };
}

export async function readOrCreateSqlInstallation(
  createSeed: () => Promise<InstallationIdentity>
): Promise<InstallationIdentity> {
  await ensureSchema();
  const connection = await sqlPool();
  const transaction = new sql.Transaction(connection);
  await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

  try {
    const existing = await new sql.Request(transaction)
      .input("productId", sql.NVarChar(64), "imap-plugin")
      .query<InstallationRow>(`
SELECT
  InstallationId AS installationId,
  ProductId AS productId,
  CreatedAtUtc AS createdAtUtc
FROM dbo.PluginInstallations WITH (UPDLOCK, HOLDLOCK)
WHERE ProductId = @productId;
`);

    const row = existing.recordset[0];
    if (row) {
      await transaction.commit();
      return fromRow(row);
    }

    const seed = await createSeed();
    await new sql.Request(transaction)
      .input("productId", sql.NVarChar(64), seed.productId)
      .input("installationId", sql.NVarChar(96), seed.installationId)
      .input("createdAtUtc", sql.DateTime2(3), new Date(seed.createdAt))
      .query(`
INSERT dbo.PluginInstallations (ProductId, InstallationId, CreatedAtUtc)
VALUES (@productId, @installationId, @createdAtUtc);
`);

    await transaction.commit();
    return seed;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

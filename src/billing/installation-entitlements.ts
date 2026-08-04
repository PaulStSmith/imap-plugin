import sql from "mssql";
import { sqlPool } from "../config/sql.js";
import type { PaidFeature } from "./subscription.js";

export interface InstallationEntitlement {
  installationId: string;
  feature: PaidFeature;
  status: string;
  customerId?: string;
  subscriptionId?: string;
  validUntil?: string;
}

type EntitlementRow = {
  installationId: string;
  feature: PaidFeature;
  status: string;
  customerId: string | null;
  subscriptionId: string | null;
  validUntilUtc: Date | null;
};

let schemaPromise: Promise<void> | undefined;

async function ensureSchema(): Promise<void> {
  schemaPromise ??= (async () => {
    const connection = await sqlPool();
    await connection.request().query(`
IF OBJECT_ID(N'dbo.InstallationEntitlements', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.InstallationEntitlements
  (
    InstallationId NVARCHAR(96) NOT NULL,
    Feature NVARCHAR(64) NOT NULL,
    Status NVARCHAR(32) NOT NULL,
    StripeCustomerId NVARCHAR(128) NULL,
    StripeSubscriptionId NVARCHAR(128) NULL,
    ValidUntilUtc DATETIME2(3) NULL,
    CreatedAtUtc DATETIME2(3) NOT NULL CONSTRAINT DF_InstallationEntitlements_CreatedAtUtc DEFAULT SYSUTCDATETIME(),
    UpdatedAtUtc DATETIME2(3) NOT NULL CONSTRAINT DF_InstallationEntitlements_UpdatedAtUtc DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_InstallationEntitlements PRIMARY KEY (InstallationId, Feature)
  );
END;
`);
  })();

  return schemaPromise;
}

function fromRow(row: EntitlementRow): InstallationEntitlement {
  return {
    installationId: row.installationId,
    feature: row.feature,
    status: row.status,
    customerId: row.customerId ?? undefined,
    subscriptionId: row.subscriptionId ?? undefined,
    validUntil: row.validUntilUtc?.toISOString()
  };
}

export async function readInstallationEntitlement(
  installationId: string,
  feature: PaidFeature
): Promise<InstallationEntitlement | undefined> {
  await ensureSchema();
  const connection = await sqlPool();
  const result = await connection.request()
    .input("installationId", sql.NVarChar(96), installationId)
    .input("feature", sql.NVarChar(64), feature)
    .query<EntitlementRow>(`
SELECT
  InstallationId AS installationId,
  Feature AS feature,
  Status AS status,
  StripeCustomerId AS customerId,
  StripeSubscriptionId AS subscriptionId,
  ValidUntilUtc AS validUntilUtc
FROM dbo.InstallationEntitlements
WHERE InstallationId = @installationId
  AND Feature = @feature;
`);

  return result.recordset[0] ? fromRow(result.recordset[0]) : undefined;
}

export async function readInstallationEntitlementBySubscription(
  subscriptionId: string,
  feature: PaidFeature
): Promise<InstallationEntitlement | undefined> {
  await ensureSchema();
  const connection = await sqlPool();
  const result = await connection.request()
    .input("subscriptionId", sql.NVarChar(128), subscriptionId)
    .input("feature", sql.NVarChar(64), feature)
    .query<EntitlementRow>(`
SELECT
  InstallationId AS installationId,
  Feature AS feature,
  Status AS status,
  StripeCustomerId AS customerId,
  StripeSubscriptionId AS subscriptionId,
  ValidUntilUtc AS validUntilUtc
FROM dbo.InstallationEntitlements
WHERE StripeSubscriptionId = @subscriptionId
  AND Feature = @feature;
`);

  return result.recordset[0] ? fromRow(result.recordset[0]) : undefined;
}

export async function upsertInstallationEntitlement(entitlement: InstallationEntitlement): Promise<InstallationEntitlement> {
  await ensureSchema();
  const connection = await sqlPool();
  const validUntil = entitlement.validUntil ? new Date(entitlement.validUntil) : null;
  await connection.request()
    .input("installationId", sql.NVarChar(96), entitlement.installationId)
    .input("feature", sql.NVarChar(64), entitlement.feature)
    .input("status", sql.NVarChar(32), entitlement.status)
    .input("customerId", sql.NVarChar(128), entitlement.customerId ?? null)
    .input("subscriptionId", sql.NVarChar(128), entitlement.subscriptionId ?? null)
    .input("validUntilUtc", sql.DateTime2(3), validUntil)
    .query(`
MERGE dbo.InstallationEntitlements AS target
USING (SELECT @installationId AS InstallationId, @feature AS Feature) AS source
ON target.InstallationId = source.InstallationId
  AND target.Feature = source.Feature
WHEN MATCHED THEN
  UPDATE SET
    Status = @status,
    StripeCustomerId = @customerId,
    StripeSubscriptionId = @subscriptionId,
    ValidUntilUtc = @validUntilUtc,
    UpdatedAtUtc = SYSUTCDATETIME()
WHEN NOT MATCHED THEN
  INSERT (InstallationId, Feature, Status, StripeCustomerId, StripeSubscriptionId, ValidUntilUtc)
  VALUES (@installationId, @feature, @status, @customerId, @subscriptionId, @validUntilUtc);
`);

  return entitlement;
}

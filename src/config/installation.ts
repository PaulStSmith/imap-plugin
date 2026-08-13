import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "./accounts.js";
import { hasSqlConnectionString } from "./sql.js";
import { readOrCreateSqlInstallation } from "./sql-installation.js";

export interface InstallationIdentity {
  installationId: string;
  productId: "imap-plugin";
  createdAt: string;
}

const PRODUCT_ID = "imap-plugin";
const INSTALLATION_FILE_NAME = "installation.json";

export function installationPath(): string {
  return join(configDir(), INSTALLATION_FILE_NAME);
}

function normalizeInstallation(value: Partial<InstallationIdentity>): InstallationIdentity | undefined {
  const installationId = typeof value.installationId === "string" ? value.installationId.trim() : "";
  if (!installationId) {
    return undefined;
  }

  return {
    installationId,
    productId: PRODUCT_ID,
    createdAt: typeof value.createdAt === "string" && value.createdAt.trim() ? value.createdAt : new Date().toISOString()
  };
}

function newInstallation(): InstallationIdentity {
  return {
    installationId: `imap_${randomUUID()}`,
    productId: PRODUCT_ID,
    createdAt: new Date().toISOString()
  };
}

async function readInstallationFile(): Promise<InstallationIdentity | undefined> {
  try {
    const parsed = JSON.parse(await readFile(installationPath(), "utf8")) as Partial<InstallationIdentity>;
    const installation = normalizeInstallation(parsed);
    if (installation) {
      return installation;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return undefined;
}

function installationStoreKind(): "file" | "sql" {
  const configured = process.env.IMAP_PLUGIN_INSTALLATION_STORE?.trim();
  if (!configured || configured === "file") {
    return "file";
  }

  if (configured === "sql") {
    if (!hasSqlConnectionString()) {
      throw new Error("IMAP_PLUGIN_SQL_CONNECTION_STRING is required when IMAP_PLUGIN_INSTALLATION_STORE=sql.");
    }
    return "sql";
  }

  throw new Error(`Unsupported IMAP_PLUGIN_INSTALLATION_STORE value "${configured}". Use "file" or "sql".`);
}

export async function readOrCreateInstallation(): Promise<InstallationIdentity> {
  if (installationStoreKind() === "sql") {
    return readOrCreateSqlInstallation(async () => await readInstallationFile() ?? newInstallation());
  }

  const existingFile = await readInstallationFile();
  if (existingFile) {
    return existingFile;
  }

  const installation = newInstallation();
  const path = installationPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(installation, null, 2)}\n`, "utf8");
  return installation;
}

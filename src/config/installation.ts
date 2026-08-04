import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "./accounts.js";

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

export async function readOrCreateInstallation(): Promise<InstallationIdentity> {
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

  const installation: InstallationIdentity = {
    installationId: `imap_${randomUUID()}`,
    productId: PRODUCT_ID,
    createdAt: new Date().toISOString()
  };
  const path = installationPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(installation, null, 2)}\n`, "utf8");
  return installation;
}

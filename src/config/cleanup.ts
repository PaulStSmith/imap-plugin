import { rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { configDir, readAccounts } from "./accounts.js";
import { createCredentialProvider } from "../credentials/index.js";
import { AccountProfile } from "../types.js";

export interface ConfigCleanupResult {
  ok: boolean;
  configDir: string;
  accountsFound: number;
  removedFiles: string[];
  removedLocalKeychainSecrets: string[];
  externalSecrets: Array<{
    accountId: string;
    provider: "env" | "1password" | "sql-vault" | "dev-sql-vault";
    reference: string;
  }>;
  errors: Array<{
    target: string;
    message: string;
  }>;
}

const CONFIG_FILE_NAMES = ["accounts.json", "preferences.json", "installation.json"];

function envCredentialName(account: AccountProfile): string {
  return account.credentialRef ?? `IMAP_PLUGIN_${account.id.toUpperCase().replaceAll("-", "_")}_PASSWORD`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function cleanupConfig(): Promise<ConfigCleanupResult> {
  const directory = configDir();
  const removedFiles: string[] = [];
  const removedLocalKeychainSecrets: string[] = [];
  const externalSecrets: ConfigCleanupResult["externalSecrets"] = [];
  const errors: ConfigCleanupResult["errors"] = [];
  const accounts = await readAccounts();

  for (const account of accounts) {
    if (account.credentialProvider === "local-keychain" || account.credentialProvider === "sql-vault" || account.credentialProvider === "dev-sql-vault") {
      try {
        await createCredentialProvider(account.credentialProvider).delete?.(account);
        removedLocalKeychainSecrets.push(account.id);
      } catch (error) {
        errors.push({
          target: `${account.credentialProvider}:${account.id}`,
          message: errorMessage(error)
        });
      }
      continue;
    }

    externalSecrets.push({
      accountId: account.id,
      provider: account.credentialProvider,
      reference: account.credentialProvider === "env" ? envCredentialName(account) : account.credentialRef ?? ""
    });
  }

  for (const fileName of CONFIG_FILE_NAMES) {
    const path = join(directory, fileName);
    try {
      await rm(path, { force: true });
      removedFiles.push(path);
    } catch (error) {
      errors.push({
        target: path,
        message: errorMessage(error)
      });
    }
  }

  try {
    await rmdir(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") {
      errors.push({
        target: directory,
        message: errorMessage(error)
      });
    }
  }

  return {
    ok: errors.length === 0,
    configDir: directory,
    accountsFound: accounts.length,
    removedFiles,
    removedLocalKeychainSecrets,
    externalSecrets,
    errors
  };
}

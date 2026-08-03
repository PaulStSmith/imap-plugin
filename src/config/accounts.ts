import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { AccountProfile } from "../types.js";

interface AccountsFile {
  accounts: AccountProfile[];
}

function configDir(): string {
  if (process.env.IMAP_PLUGIN_CONFIG_DIR) {
    return process.env.IMAP_PLUGIN_CONFIG_DIR;
  }

  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "imap-plugin");
  }

  return join(homedir(), ".config", "imap-plugin");
}

export function accountsPath(): string {
  return join(configDir(), "accounts.json");
}

export async function readAccounts(): Promise<AccountProfile[]> {
  try {
    const raw = await readFile(accountsPath(), "utf8");
    const parsed = JSON.parse(raw) as AccountsFile;
    return Array.isArray(parsed.accounts) ? parsed.accounts : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function writeAccounts(accounts: AccountProfile[]): Promise<void> {
  const path = accountsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ accounts }, null, 2)}\n`, "utf8");
}

export async function getAccount(accountId: string): Promise<AccountProfile> {
  const account = (await readAccounts()).find((entry) => entry.id === accountId);
  if (!account) {
    throw new Error(`No IMAP account profile exists for "${accountId}".`);
  }

  return account;
}

export async function upsertAccount(account: AccountProfile): Promise<AccountProfile> {
  const accounts = await readAccounts();
  const next = accounts.filter((entry) => entry.id !== account.id);
  next.push(account);
  await writeAccounts(next.sort((a, b) => a.id.localeCompare(b.id)));
  return account;
}

export async function removeAccount(accountId: string): Promise<boolean> {
  const accounts = await readAccounts();
  const next = accounts.filter((entry) => entry.id !== accountId);
  await writeAccounts(next);
  return next.length !== accounts.length;
}

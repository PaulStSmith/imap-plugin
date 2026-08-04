import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { AccountProfile } from "../types.js";
import { readSqlAccounts, removeSqlAccount, upsertSqlAccount, writeSqlAccounts } from "./sql-accounts.js";

interface AccountsFile {
  accounts: AccountProfile[];
}

export function configDir(): string {
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

function accountStoreKind(): "file" | "sql" {
  const configured = process.env.IMAP_PLUGIN_ACCOUNT_STORE;
  if (!configured || configured === "file") {
    return "file";
  }

  if (configured === "sql") {
    return "sql";
  }

  throw new Error(`Unsupported IMAP_PLUGIN_ACCOUNT_STORE value "${configured}". Use "file" or "sql".`);
}

export async function readAccounts(): Promise<AccountProfile[]> {
  if (accountStoreKind() === "sql") {
    return readSqlAccounts();
  }

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
  if (accountStoreKind() === "sql") {
    await writeSqlAccounts(accounts);
    return;
  }

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
  if (accountStoreKind() === "sql") {
    return upsertSqlAccount(account);
  }

  const accounts = await readAccounts();
  const next = accounts.filter((entry) => entry.id !== account.id);
  next.push(account);
  await writeAccounts(next.sort((a, b) => a.id.localeCompare(b.id)));
  return account;
}

export async function removeAccount(accountId: string): Promise<boolean> {
  if (accountStoreKind() === "sql") {
    return removeSqlAccount(accountId);
  }

  const accounts = await readAccounts();
  const next = accounts.filter((entry) => entry.id !== accountId);
  await writeAccounts(next);
  return next.length !== accounts.length;
}

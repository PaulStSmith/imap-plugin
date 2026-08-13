import { AccountProfile, CredentialProviderKind } from "../types.js";
import { CredentialProvider } from "./provider.js";
import { EnvCredentialProvider } from "./env.js";
import { LocalKeychainCredentialProvider } from "./local-keychain.js";
import { OnePasswordCredentialProvider } from "./one-password.js";
import { DevSqlVaultCredentialProvider, devSqlVaultCredentialRef } from "./dev-sql-vault.js";
import { SqlVaultCredentialProvider, sqlVaultCredentialRef } from "./sql-vault.js";

export function createCredentialProvider(kind: CredentialProviderKind): CredentialProvider {
  switch (kind) {
    case "local-keychain":
      return new LocalKeychainCredentialProvider();
    case "1password":
      return new OnePasswordCredentialProvider();
    case "env":
      return new EnvCredentialProvider();
    case "sql-vault":
      return new SqlVaultCredentialProvider();
    case "dev-sql-vault":
      return new DevSqlVaultCredentialProvider();
  }
}

export function defaultCredentialProviderKind(): CredentialProviderKind {
  const configured = process.env.IMAP_PLUGIN_CREDENTIAL_PROVIDER;
  if (configured === "1password" || configured === "env" || configured === "local-keychain" || configured === "sql-vault" || configured === "dev-sql-vault") {
    return configured;
  }

  return "local-keychain";
}

export function providerForAccount(account: AccountProfile): CredentialProvider {
  return createCredentialProvider(account.credentialProvider);
}

export function storesPassword(provider: CredentialProviderKind): boolean {
  return provider === "local-keychain" || provider === "sql-vault" || provider === "dev-sql-vault";
}

export function credentialRefForAccount(account: AccountProfile): string | undefined {
  if (account.credentialProvider === "sql-vault") {
    return sqlVaultCredentialRef(account);
  }

  if (account.credentialProvider === "dev-sql-vault") {
    return devSqlVaultCredentialRef(account);
  }

  return account.credentialRef;
}

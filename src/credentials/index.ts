import { AccountProfile, CredentialProviderKind } from "../types.js";
import { CredentialProvider } from "./provider.js";
import { EnvCredentialProvider } from "./env.js";
import { LocalKeychainCredentialProvider } from "./local-keychain.js";
import { OnePasswordCredentialProvider } from "./one-password.js";

export function createCredentialProvider(kind: CredentialProviderKind): CredentialProvider {
  switch (kind) {
    case "local-keychain":
      return new LocalKeychainCredentialProvider();
    case "1password":
      return new OnePasswordCredentialProvider();
    case "env":
      return new EnvCredentialProvider();
  }
}

export function defaultCredentialProviderKind(): CredentialProviderKind {
  const configured = process.env.IMAP_PLUGIN_CREDENTIAL_PROVIDER;
  if (configured === "1password" || configured === "env" || configured === "local-keychain") {
    return configured;
  }

  return "local-keychain";
}

export function providerForAccount(account: AccountProfile): CredentialProvider {
  return createCredentialProvider(account.credentialProvider);
}

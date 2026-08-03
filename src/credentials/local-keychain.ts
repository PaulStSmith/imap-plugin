import { AccountProfile, MailboxCredential } from "../types.js";
import { CredentialProvider } from "./provider.js";

const SERVICE = "imap-plugin";
type KeytarModule = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

async function loadKeytar(): Promise<KeytarModule> {
  try {
    const imported = await import("keytar") as unknown as Record<string, unknown>;
    const keytar = typeof imported.setPassword === "function" ? imported : imported.default;
    if (!keytar || typeof (keytar as Partial<KeytarModule>).setPassword !== "function") {
      throw new Error("Unsupported keytar module shape.");
    }

    return keytar as KeytarModule;
  } catch {
    throw new Error("The local-keychain provider requires the keytar package and OS credential store support.");
  }
}

export class LocalKeychainCredentialProvider implements CredentialProvider {
  async get(account: AccountProfile): Promise<MailboxCredential> {
    const keytar = await loadKeytar();
    const password = await keytar.getPassword(SERVICE, account.id);
    if (!password) {
      throw new Error(`No local keychain password found for account "${account.id}".`);
    }

    return {
      username: account.username,
      password
    };
  }

  async set(account: AccountProfile, password: string): Promise<void> {
    const keytar = await loadKeytar();
    await keytar.setPassword(SERVICE, account.id, password);
  }

  async delete(account: AccountProfile): Promise<void> {
    const keytar = await loadKeytar();
    await keytar.deletePassword(SERVICE, account.id);
  }
}

import { AccountProfile, MailboxCredential } from "../types.js";
import { CredentialProvider } from "./provider.js";

const SERVICE = "imap-plugin";

async function loadKeytar() {
  try {
    return await import("keytar");
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

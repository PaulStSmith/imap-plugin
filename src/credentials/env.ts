import { AccountProfile, MailboxCredential } from "../types.js";
import { CredentialProvider } from "./provider.js";

export class EnvCredentialProvider implements CredentialProvider {
  async get(account: AccountProfile): Promise<MailboxCredential> {
    const envName = account.credentialRef ?? `IMAP_PLUGIN_${account.id.toUpperCase().replaceAll("-", "_")}_PASSWORD`;
    const password = process.env[envName];
    if (!password) {
      throw new Error(`Environment variable "${envName}" is not set for account "${account.id}".`);
    }

    return {
      username: account.username,
      password
    };
  }
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AccountProfile, MailboxCredential } from "../types.js";
import { CredentialProvider } from "./provider.js";

const execFileAsync = promisify(execFile);

export class OnePasswordCredentialProvider implements CredentialProvider {
  async get(account: AccountProfile): Promise<MailboxCredential> {
    if (!account.credentialRef) {
      throw new Error(`Account "${account.id}" must include a 1Password secret reference.`);
    }

    const { stdout } = await execFileAsync("op", ["read", account.credentialRef], {
      windowsHide: true
    });

    const password = stdout.trim();
    if (!password) {
      throw new Error(`1Password returned an empty secret for account "${account.id}".`);
    }

    return {
      username: account.username,
      password
    };
  }
}

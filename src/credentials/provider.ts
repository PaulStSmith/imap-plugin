import { AccountProfile, MailboxCredential } from "../types.js";

export interface CredentialProvider {
  get(account: AccountProfile): Promise<MailboxCredential>;
  set?(account: AccountProfile, password: string): Promise<void>;
  delete?(account: AccountProfile): Promise<void>;
}

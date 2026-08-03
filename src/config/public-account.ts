import { AccountProfile } from "../types.js";

export function publicAccount(account: AccountProfile) {
  return {
    id: account.id,
    host: account.host,
    port: account.port,
    secure: account.secure,
    username: account.username,
    credentialProvider: account.credentialProvider,
    credentialRef: account.credentialRef
  };
}

import { AccountProfile } from "../types.js";

export function publicAccount(account: AccountProfile) {
  return {
    id: account.id,
    email: account.email,
    host: account.host,
    port: account.port,
    secure: account.secure,
    username: account.username,
    credentialProvider: account.credentialProvider,
    credentialRef: account.credentialRef,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    smtpSecure: account.smtpSecure,
    smtpUsername: account.smtpUsername
  };
}

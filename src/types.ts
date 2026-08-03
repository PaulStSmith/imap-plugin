export type CredentialProviderKind = "local-keychain" | "1password" | "env";

export interface AccountProfile {
  id: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  credentialProvider: CredentialProviderKind;
  credentialRef?: string;
}

export interface MailboxCredential {
  username: string;
  password: string;
}

export interface MessageSummary {
  uid: number;
  subject: string | null;
  from: string[];
  to: string[];
  date: string | null;
  flags: string[];
  seen: boolean;
  answered: boolean;
  hasAttachments: boolean;
}

export interface MessageDetail extends MessageSummary {
  cc: string[];
  bcc: string[];
  text: string;
  html?: string;
  attachments: AttachmentMetadata[];
}

export interface AttachmentMetadata {
  filename: string | null;
  contentType: string;
  size: number | null;
  contentId: string | null;
}

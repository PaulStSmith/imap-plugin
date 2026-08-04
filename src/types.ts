export type CredentialProviderKind = "local-keychain" | "1password" | "env" | "dev-sql-vault";

export interface AccountProfile {
  id: string;
  email?: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  credentialProvider: CredentialProviderKind;
  credentialRef?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUsername?: string;
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
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  text: string;
  html?: string;
  attachments: AttachmentMetadata[];
}

export interface AttachmentMetadata {
  index: number;
  filename: string | null;
  contentType: string;
  size: number | null;
  contentId: string | null;
}

export interface AttachmentContent extends AttachmentMetadata {
  contentBase64: string;
}

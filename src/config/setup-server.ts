import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";
import { lookup, resolveMx, resolveSrv } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { requireSubscription, subscriptionStatus } from "../billing/subscription.js";
import { getAccount, readAccounts, removeAccount, upsertAccount } from "./accounts.js";
import { readPreferences, updatePreferences } from "./preferences.js";
import { publicAccount } from "./public-account.js";
import { createCredentialProvider } from "../credentials/index.js";
import { searchMessages, testAccount, updateMessageFlags } from "../mail/imap-client.js";
import { sendMessage, testSmtpConnection } from "../mail/smtp-client.js";
import { AccountProfile } from "../types.js";
import { addAccountSchema } from "../tools/schemas.js";

export interface SetupServerInfo {
  url: string;
  host: string;
  port: number;
  token: string;
}

const SETUP_UI_VERSION = "20260803.1845";

let setupServerPromise: Promise<SetupServerInfo> | undefined;

interface DiscoveryInput {
  email: string;
}

interface DiscoveryCandidate {
  provider: string;
  host: string;
  port: number;
  secure: boolean;
  source: string;
  confidence: number;
  username: string;
  note?: string;
  resolves?: boolean;
}

interface DiscoveryResult {
  email: string;
  domain: string;
  provider: string | null;
  candidates: DiscoveryCandidate[];
  mx: Array<{ exchange: string; priority: number }>;
  warnings: string[];
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(value, null, 2));
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }

  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" && property.trim() ? property : undefined;
}

function booleanProperty(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>)[key]);
}

function diagnosticMessage(category: string, message: string): string {
  if (category === "authentication") {
    return "Authentication failed. Check the username and password or use an app password if your provider requires one.";
  }

  if (category === "dns") {
    return "The IMAP host could not be resolved. Check the server hostname.";
  }

  if (category === "refused") {
    return "The IMAP server refused the connection. Check the host, port, and TLS setting.";
  }

  if (category === "timeout") {
    return "The IMAP connection timed out. Check the host, port, network, or firewall.";
  }

  if (category === "tls") {
    return "TLS failed. Check whether this server expects TLS on this port.";
  }

  if (category === "credential") {
    return message;
  }

  if (category === "validation") {
    return message;
  }

  return message || "Command failed.";
}

function diagnosticCategory(error: unknown): string {
  const code = stringProperty(error, "code");
  const name = stringProperty(error, "name");
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = [code, name, message, stringProperty(error, "response")].filter(Boolean).join(" ").toLowerCase();

  if (booleanProperty(error, "authenticationFailed") || /authentication|auth|invalid credentials|login failed/.test(normalized)) {
    return "authentication";
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "dns";
  }

  if (code === "ECONNREFUSED") {
    return "refused";
  }

  if (code === "ETIMEDOUT" || code === "CONNECT_TIMEOUT" || /timed out|timeout/.test(normalized)) {
    return "timeout";
  }

  if (/tls|ssl|certificate|self-signed|hostname\/ip does not match/.test(normalized)) {
    return "tls";
  }

  if (/keychain|credential store|password found|password is required/.test(normalized)) {
    return "credential";
  }

  if (/valid json|invalid setup token|zod|required|expected/.test(normalized)) {
    return "validation";
  }

  return "unknown";
}

function diagnosticSuggestions(category: string): string[] {
  if (category === "authentication") {
    return [
      "Verify the full mailbox username.",
      "Use an app password if two-factor authentication is enabled.",
      "Confirm IMAP access is enabled for the account."
    ];
  }

  if (category === "dns") {
    return ["Check for a typo in the IMAP host.", "Use the provider's IMAP server name, not the webmail URL."];
  }

  if (category === "refused") {
    return ["Try port 993 with TLS on, or port 143 with TLS off.", "Confirm the provider allows IMAP connections."];
  }

  if (category === "timeout") {
    return ["Check VPN, firewall, and network restrictions.", "Confirm the host and port are reachable from this computer."];
  }

  if (category === "tls") {
    return ["For port 993, keep TLS on.", "For port 143, try TLS off if the provider documents STARTTLS/plain IMAP."];
  }

  if (category === "credential") {
    return ["Enter the password again, then save or test.", "Check that the OS credential store is available."];
  }

  return [];
}

function publicError(error: unknown) {
  const category = diagnosticCategory(error);
  const message = error instanceof Error ? error.message : String(error || "Unknown error.");
  const context = error && typeof error === "object"
    ? (error as { imapAccountContext?: ReturnType<typeof publicAccount> }).imapAccountContext
    : undefined;

  return {
    error: diagnosticMessage(category, message),
    diagnostic: {
      category,
      originalMessage: message,
      code: stringProperty(error, "code"),
      name: stringProperty(error, "name"),
      response: stringProperty(error, "response"),
      responseStatus: stringProperty(error, "responseStatus"),
      account: context,
      suggestions: diagnosticSuggestions(category)
    }
  };
}

function withAccountContext(error: unknown, account: AccountProfile): Error {
  const normalized = error instanceof Error ? error : new Error(String(error || "Unknown error."));
  (normalized as { imapAccountContext?: ReturnType<typeof publicAccount> }).imapAccountContext = publicAccount(account);
  return normalized;
}

function parseEmailAddress(value: unknown): { email: string; localPart: string; domain: string } {
  if (!value || typeof value !== "object") {
    throw new Error("Email address is required.");
  }

  const email = String((value as DiscoveryInput).email ?? "").trim().toLowerCase();
  const match = email.match(/^([^@\s]+)@([^@\s]+\.[^@\s]+)$/);
  if (!match) {
    throw new Error("Enter a valid email address before detecting settings.");
  }

  return {
    email,
    localPart: match[1],
    domain: match[2]
  };
}

function addCandidate(candidates: DiscoveryCandidate[], candidate: DiscoveryCandidate): void {
  const key = `${candidate.host.toLowerCase()}:${candidate.port}:${candidate.secure}`;
  const existing = candidates.find((entry) => `${entry.host.toLowerCase()}:${entry.port}:${entry.secure}` === key);
  if (!existing) {
    candidates.push(candidate);
    return;
  }

  if (candidate.confidence > existing.confidence) {
    Object.assign(existing, candidate);
  }
}

function hostnameFromXml(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`, "i"));
  return match?.[1]?.trim();
}

function usernameFromTemplate(template: string | undefined, email: string, localPart: string): string {
  if (!template) {
    return email;
  }

  return template
    .replace(/%EMAILADDRESS%/gi, email)
    .replace(/%EMAILLOCALPART%/gi, localPart);
}

async function fetchAutoconfig(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }

    const text = await response.text();
    return text.includes("<clientConfig") ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function addAutoconfigCandidates(
  candidates: DiscoveryCandidate[],
  xml: string,
  email: string,
  localPart: string
): void {
  const blocks = xml.match(/<incomingServer\b[\s\S]*?<\/incomingServer>/gi) ?? [];
  for (const block of blocks) {
    if (!/type=["']imap["']/i.test(block)) {
      continue;
    }

    const host = hostnameFromXml(block, "hostname");
    const port = Number(hostnameFromXml(block, "port") ?? "993");
    if (!host || !Number.isInteger(port)) {
      continue;
    }

    const socketType = (hostnameFromXml(block, "socketType") ?? "").toUpperCase();
    addCandidate(candidates, {
      provider: "Autoconfig",
      host,
      port,
      secure: socketType !== "STARTTLS" && port === 993,
      source: "autoconfig",
      confidence: 0.95,
      username: usernameFromTemplate(hostnameFromXml(block, "username"), email, localPart),
      note: "Discovered from the domain's email client autoconfig file."
    });
  }
}

function addProviderCandidates(
  candidates: DiscoveryCandidate[],
  mxHosts: string[],
  email: string,
  localPart: string,
  domain: string,
  warnings: string[]
): string | null {
  const joined = mxHosts.join(" ");
  if (/google\.com|googlemail\.com|aspmx\.l\.google/i.test(joined)) {
    addCandidate(candidates, {
      provider: "Google Workspace or Gmail",
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      source: "mx",
      confidence: 0.88,
      username: email,
      note: "MX records point to Google mail hosting."
    });
    return "Google Workspace or Gmail";
  }

  if (/outlook\.com|protection\.outlook\.com|mail\.protection\.outlook\.com|microsoft/i.test(joined)) {
    addCandidate(candidates, {
      provider: "Microsoft 365 or Outlook",
      host: "outlook.office365.com",
      port: 993,
      secure: true,
      source: "mx",
      confidence: 0.86,
      username: email,
      note: "MX records point to Microsoft mail hosting. IMAP may need to be enabled by the tenant admin."
    });
    return "Microsoft 365 or Outlook";
  }

  if (/zoho/i.test(joined)) {
    addCandidate(candidates, {
      provider: "Zoho Mail",
      host: "imappro.zoho.com",
      port: 993,
      secure: true,
      source: "mx",
      confidence: 0.82,
      username: email,
      note: "MX records point to Zoho mail hosting."
    });
    return "Zoho Mail";
  }

  if (/yahoodns\.net|yahoo/i.test(joined)) {
    addCandidate(candidates, {
      provider: "Yahoo Mail",
      host: "imap.mail.yahoo.com",
      port: 993,
      secure: true,
      source: "mx",
      confidence: 0.8,
      username: email,
      note: "MX records point to Yahoo mail hosting."
    });
    return "Yahoo Mail";
  }

  if (/icloud|me\.com|mac\.com|apple/i.test(joined)) {
    addCandidate(candidates, {
      provider: "iCloud Mail",
      host: "imap.mail.me.com",
      port: 993,
      secure: true,
      source: "mx",
      confidence: 0.8,
      username: email,
      note: "MX records point to Apple mail hosting."
    });
    return "iCloud Mail";
  }

  if (/protonmail|proton\.ch/i.test(joined)) {
    warnings.push("MX records point to Proton Mail. Proton generally requires Proton Mail Bridge for IMAP.");
    return "Proton Mail";
  }

  if (/proofpoint|mimecast|barracuda|messagelabs|iphmx|ppe-hosted/i.test(joined)) {
    warnings.push("MX records point to a mail security gateway, so they may not reveal the IMAP server.");
  }

  addCandidate(candidates, {
    provider: "Domain default",
    host: `imap.${domain}`,
    port: 993,
    secure: true,
    source: "guess",
    confidence: 0.35,
    username: email,
    note: "Common IMAP hostname pattern for custom domains."
  });
  addCandidate(candidates, {
    provider: "Domain default",
    host: `mail.${domain}`,
    port: 993,
    secure: true,
    source: "guess",
    confidence: 0.3,
    username: email,
    note: "Common mail hostname pattern for custom domains."
  });
  addCandidate(candidates, {
    provider: "Domain default",
    host: domain,
    port: 993,
    secure: true,
    source: "guess",
    confidence: 0.22,
    username: email,
    note: "Fallback guess using the bare email domain."
  });

  return null;
}

async function markResolvable(candidate: DiscoveryCandidate): Promise<DiscoveryCandidate> {
  try {
    await lookup(candidate.host);
    return { ...candidate, resolves: true };
  } catch {
    return { ...candidate, resolves: false };
  }
}

async function discoverMailboxSettings(rawInput: unknown): Promise<DiscoveryResult> {
  const { email, localPart, domain } = parseEmailAddress(rawInput);
  const warnings: string[] = [];
  const candidates: DiscoveryCandidate[] = [];

  const [mxResult, imapsSrvResult, imapSrvResult, autoconfigResult, wellKnownAutoconfigResult] = await Promise.allSettled([
    resolveMx(domain),
    resolveSrv(`_imaps._tcp.${domain}`),
    resolveSrv(`_imap._tcp.${domain}`),
    fetchAutoconfig(`https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`),
    fetchAutoconfig(`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`)
  ]);

  const mx = mxResult.status === "fulfilled"
    ? mxResult.value.sort((a, b) => a.priority - b.priority)
    : [];

  if (mxResult.status === "rejected") {
    warnings.push("Could not read MX records for this domain.");
  }

  for (const result of [imapsSrvResult, imapSrvResult]) {
    if (result.status !== "fulfilled") {
      continue;
    }

    for (const srv of result.value) {
      if (!srv.name || srv.port < 1 || srv.port > 65535) {
        continue;
      }

      addCandidate(candidates, {
        provider: "DNS SRV",
        host: srv.name,
        port: srv.port,
        secure: srv.port === 993,
        source: "srv",
        confidence: 0.9,
        username: email,
        note: "Discovered from DNS SRV records."
      });
    }
  }

  for (const result of [autoconfigResult, wellKnownAutoconfigResult]) {
    if (result.status === "fulfilled" && result.value) {
      addAutoconfigCandidates(candidates, result.value, email, localPart);
    }
  }

  const provider = addProviderCandidates(candidates, mx.map((entry) => entry.exchange.toLowerCase()), email, localPart, domain, warnings);
  const resolvedCandidates = await Promise.all(candidates.map(markResolvable));

  return {
    email,
    domain,
    provider,
    candidates: resolvedCandidates.sort((a, b) => Number(b.resolves) - Number(a.resolves) || b.confidence - a.confidence),
    mx,
    warnings
  };
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(html);
}

async function sendAsset(response: ServerResponse, path: string, contentType: string): Promise<void> {
  const data = await readFile(path);
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  response.end(data);
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function accountFromInput(input: ReturnType<typeof addAccountSchema.parse>): AccountProfile {
  return {
    id: input.accountId,
    email: input.email,
    host: input.host,
    port: input.port,
    secure: input.secure,
    username: input.username,
    credentialProvider: input.credentialProvider,
    credentialRef: input.credentialRef,
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpSecure: input.smtpSecure,
    smtpUsername: input.smtpUsername
  };
}

async function saveAccount(rawInput: unknown): Promise<AccountProfile> {
  const input = addAccountSchema.parse(rawInput);
  if (hasSmtpOverrides(input)) {
    const required = await requireSubscription("mail_actions", "SMTP configuration");
    if (required) {
      throw new Error(required.message);
    }
  }

  const account = accountFromInput(input);
  const existing = (await readAccounts()).find((entry) => entry.id === account.id);

  if (account.credentialProvider === "local-keychain") {
    if (input.password) {
      await createCredentialProvider("local-keychain").set?.(account, input.password);
    } else if (!existing) {
      throw new Error("A password is required for a new local-keychain account.");
    }
  }

  await upsertAccount(account);
  return account;
}

function emailAddress(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed) ? trimmed : undefined;
}

function roundTripRecipient(account: AccountProfile): string {
  const recipient = emailAddress(account.email) || emailAddress(account.username);
  if (!recipient) {
    throw new Error("Round-trip test requires the account's mailbox email address. Add the mailbox email to the account profile, then try again.");
  }

  return recipient;
}

function roundTripSender(account: AccountProfile): string {
  return account.smtpUsername || account.username;
}

async function testInputAccount(rawInput: unknown) {
  const input = addAccountSchema.parse(rawInput);
  const account = accountFromInput(input);
  const overridePassword = account.credentialProvider === "local-keychain" ? input.password : undefined;
  const paid = (await subscriptionStatus("mail_actions")).live;
  try {
    return {
      imap: await testAccount(account, overridePassword),
      smtp: paid
        ? await testSmtpConnection(account, {
          smtpHost: input.smtpHost,
          smtpPort: input.smtpPort,
          smtpSecure: input.smtpSecure,
          smtpUsername: input.smtpUsername,
          overridePassword
        })
        : undefined
    };
  } catch (error) {
    throw withAccountContext(error, account);
  }
}

async function testSavedAccount(account: AccountProfile) {
  const paid = (await subscriptionStatus("mail_actions")).live;
  try {
    return {
      imap: await testAccount(account),
      smtp: paid ? await testSmtpConnection(account) : undefined
    };
  } catch (error) {
    throw withAccountContext(error, account);
  }
}

function hasSmtpOverrides(input: ReturnType<typeof addAccountSchema.parse>): boolean {
  return Boolean(input.smtpHost || input.smtpPort || input.smtpSecure || input.smtpUsername);
}

async function roundTripAccount(account: AccountProfile, overridePassword?: string) {
  const subject = `IMAP Plugin round-trip ${randomBytes(8).toString("hex")}`;
  const sender = roundTripSender(account);
  const recipient = roundTripRecipient(account);
  await testAccount(account, overridePassword);
  await sendMessage(account, {
    to: [recipient],
    subject,
    text: `This is an IMAP Plugin round-trip test sent at ${new Date().toISOString()}.`,
    overridePassword
  });

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await delay(attempt === 1 ? 2500 : 5000);
    const messages = await searchMessages(account, {
      mailbox: "INBOX",
      subject,
      limit: 5
    }, overridePassword);

    if (messages.length) {
      await updateMessageFlags(account, {
        mailbox: "INBOX",
        uids: [messages[0].uid],
        mode: "add",
        flags: ["\\Seen"]
      });

      return {
        ok: true,
        subject,
        sender,
        recipient,
        found: true,
        attempts: attempt,
        markedRead: true,
        steps: roundTripSteps(true),
        messages
      };
    }
  }

  return {
    ok: false,
    subject,
    sender,
    recipient,
    found: false,
    attempts: 6,
    markedRead: false,
    steps: roundTripSteps(false),
    message: "The test email was sent, but it was not found in INBOX yet."
  };
}

function roundTripSteps(found: boolean) {
  return [
    { id: "sending", label: "Sending email", status: "done" },
    { id: "sent", label: "Email sent.", status: "done" },
    { id: "searching", label: "Searching round trip email", status: "done" },
    { id: "found", label: "Round trip email found.", status: found ? "done" : "failed" },
    { id: "marking-read", label: "Marking email read.", status: found ? "done" : "pending" },
    { id: "successful", label: "Round trip successful.", status: found ? "done" : "pending" }
  ];
}

async function roundTripInputAccount(rawInput: unknown) {
  const required = await requireSubscription("mail_actions", "SMTP round-trip test");
  if (required) {
    return required;
  }
  await requireSmtpActionsEnabled();

  const input = addAccountSchema.parse(rawInput);
  const account = accountFromInput(input);
  const overridePassword = account.credentialProvider === "local-keychain" ? input.password : undefined;
  try {
    return await roundTripAccount(account, overridePassword);
  } catch (error) {
    throw withAccountContext(error, account);
  }
}

async function roundTripSavedAccount(account: AccountProfile) {
  const required = await requireSubscription("mail_actions", "SMTP round-trip test");
  if (required) {
    return required;
  }
  await requireSmtpActionsEnabled();

  try {
    return await roundTripAccount(account);
  } catch (error) {
    throw withAccountContext(error, account);
  }
}

async function requireSmtpActionsEnabled(): Promise<void> {
  if (!(await readPreferences()).smtpActionsEnabled) {
    throw new Error("SMTP sending is disabled in plugin settings.");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isAuthorized(request: IncomingMessage, url: URL, token: string): boolean {
  return request.headers["x-imap-plugin-token"] === token || url.searchParams.get("token") === token;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "http://127.0.0.1",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, x-imap-plugin-token"
    });
    response.end();
    return;
  }

  if (url.pathname === "/" && request.method === "GET") {
    sendHtml(response, renderSetupPage(token));
    return;
  }

  if (url.pathname === "/assets/imap-plugin-logo-square.png" && request.method === "GET") {
    await sendAsset(response, join(process.cwd(), "assets", "imap-plugin-logo-square.png"), "image/png");
    return;
  }

  if (!isAuthorized(request, url, token)) {
    sendJson(response, 403, { error: "Invalid setup token." });
    return;
  }

  try {
    if (url.pathname === "/api/accounts" && request.method === "GET") {
      const accounts = await readAccounts();
      sendJson(response, 200, { accounts: accounts.map(publicAccount) });
      return;
    }

    if (url.pathname === "/api/subscription" && request.method === "GET") {
      sendJson(response, 200, {
        subscription: await subscriptionStatus("mail_actions"),
        preferences: await readPreferences()
      });
      return;
    }

    if (url.pathname === "/api/preferences" && request.method === "POST") {
      const required = await requireSubscription("mail_actions", "SMTP action preferences");
      if (required) {
        sendJson(response, 402, required);
        return;
      }

      const body = await readJson(request) as Partial<ReturnType<typeof readPreferences>>;
      sendJson(response, 200, {
        preferences: await updatePreferences({
          smtpActionsEnabled: Boolean((body as { smtpActionsEnabled?: unknown }).smtpActionsEnabled)
        })
      });
      return;
    }

    if (url.pathname === "/api/accounts" && request.method === "POST") {
      const account = await saveAccount(await readJson(request));
      sendJson(response, 200, { account: publicAccount(account) });
      return;
    }

    if (url.pathname === "/api/test" && request.method === "POST") {
      sendJson(response, 200, await testInputAccount(await readJson(request)));
      return;
    }

    if (url.pathname === "/api/round-trip" && request.method === "POST") {
      const result = await roundTripInputAccount(await readJson(request));
      sendJson(response, "ok" in result && result.ok === false && "code" in result ? 402 : 200, result);
      return;
    }

    if (url.pathname === "/api/discover" && request.method === "POST") {
      sendJson(response, 200, await discoverMailboxSettings(await readJson(request)));
      return;
    }

    const removeMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
    if (removeMatch && request.method === "DELETE") {
      const accountId = decodeURIComponent(removeMatch[1]);
      const account = await getAccount(accountId);
      await createCredentialProvider(account.credentialProvider).delete?.(account);
      sendJson(response, 200, { removed: await removeAccount(accountId) });
      return;
    }

    const testMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/test$/);
    if (testMatch && request.method === "POST") {
      const account = await getAccount(decodeURIComponent(testMatch[1]));
      sendJson(response, 200, await testSavedAccount(account));
      return;
    }

    const roundTripMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/round-trip$/);
    if (roundTripMatch && request.method === "POST") {
      const result = await roundTripSavedAccount(await getAccount(decodeURIComponent(roundTripMatch[1])));
      sendJson(response, "ok" in result && result.ok === false && "code" in result ? 402 : 200, result);
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    sendJson(response, 400, publicError(error));
  }
}

function listenOnPort(port: number, token: string): Promise<SetupServerInfo> {
  return new Promise((resolve, reject) => {
    const host = "127.0.0.1";
    const server = createServer((request, response) => {
      void handleRequest(request, response, token);
    });

    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const resolvedPort = typeof address === "object" && address ? address.port : port;
      resolve({
        host,
        port: resolvedPort,
        token,
        url: `http://${host}:${resolvedPort}/?token=${encodeURIComponent(token)}&v=${encodeURIComponent(SETUP_UI_VERSION)}`
      });
    });
  });
}

export async function startSetupServer(): Promise<SetupServerInfo> {
  if (!setupServerPromise) {
    setupServerPromise = (async () => {
      const token = process.env.IMAP_PLUGIN_SETUP_TOKEN ?? randomBytes(24).toString("base64url");
      const preferredPort = Number(process.env.IMAP_PLUGIN_SETUP_PORT ?? "37891");

      try {
        return await listenOnPort(preferredPort, token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
          throw error;
        }

        return listenOnPort(0, token);
      }
    })();
  }

  return setupServerPromise;
}

function renderSetupPage(token: string): string {
  const tokenJson = JSON.stringify(token);
  const setupVersionJson = JSON.stringify(SETUP_UI_VERSION);
  const processIdJson = JSON.stringify(process.pid);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="cache-control" content="no-store">
  <meta http-equiv="pragma" content="no-cache">
  <meta http-equiv="expires" content="0">
  <title>IMAP Mailboxes Setup</title>
  <style>
    :root {
      color-scheme: light dark;
      --ink: #1f2933;
      --muted: #5f6f7a;
      --line: #d8e1e7;
      --surface: #ffffff;
      --page: #f5f7f4;
      --field: #ffffff;
      --subtle: #fbfcfc;
      --chip: #e8f1f4;
      --progress-track: #eef3f4;
      --on-accent: #ffffff;
      --overlay: rgba(31, 41, 51, 0.48);
      --shadow-soft: rgba(31, 41, 51, 0.16);
      --shadow-strong: rgba(31, 41, 51, 0.28);
      --logo-bg: #ffffff;
      --accent: #256d85;
      --accent-dark: #1f586d;
      --accent-soft: #e8f4f7;
      --ok: #1c7c54;
      --warn: #b85c38;
      --focus: #e1b12c;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --ink: #edf3f6;
        --muted: #a9b7c0;
        --line: #31424c;
        --surface: #172229;
        --page: #0d151a;
        --field: #101a20;
        --subtle: #121d23;
        --chip: #203640;
        --progress-track: #22343c;
        --on-accent: #ffffff;
        --overlay: rgba(4, 10, 14, 0.72);
        --shadow-soft: rgba(0, 0, 0, 0.38);
        --shadow-strong: rgba(0, 0, 0, 0.55);
        --logo-bg: #ffffff;
        --accent: #5fb3ca;
        --accent-dark: #8bd5e6;
        --accent-soft: #12313a;
        --ok: #6fd1a2;
        --warn: #ffad85;
        --focus: #f2c94c;
      }
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      color: var(--ink);
      background: var(--page);
      line-height: 1.45;
    }

    main {
      width: min(1120px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0;
    }

    header {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      align-items: center;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--line);
    }

    .brand-lockup {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .brand-lockup img {
      width: 56px;
      height: 56px;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: var(--logo-bg);
      object-fit: contain;
    }

    h1, h2 {
      margin: 0;
      letter-spacing: 0;
    }

    h1 {
      font-size: 28px;
      line-height: 1.1;
    }

    h2 {
      font-size: 18px;
      margin-bottom: 14px;
    }

    .subhead {
      margin: 8px 0 0;
      color: var(--muted);
      max-width: 680px;
    }

    .status {
      min-width: 220px;
      text-align: right;
      color: var(--muted);
      font-size: 14px;
    }

    .status strong {
      display: block;
      color: var(--ink);
      font-size: 13px;
      font-weight: 800;
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 360px;
      gap: 24px;
      padding-top: 24px;
      align-items: start;
    }

    section {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 20px;
    }

    form {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }

    label {
      display: grid;
      gap: 6px;
      font-size: 13px;
      color: var(--muted);
    }

    .field-heading {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .help-text {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
    }

    input, select {
      width: 100%;
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px 10px;
      font: inherit;
      color: var(--ink);
      background: var(--field);
    }

    input:focus, select:focus, button:focus {
      outline: 3px solid color-mix(in srgb, var(--focus) 35%, transparent);
      outline-offset: 1px;
    }

    .span-2 { grid-column: 1 / -1; }

    .credential-card {
      display: grid;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: var(--accent-soft);
    }

    .credential-card strong {
      color: var(--ink);
    }

    .credential-topline {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .info {
      position: relative;
    }

    .info summary {
      width: 26px;
      height: 26px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--line);
      border-radius: 50%;
      color: var(--accent-dark);
      background: var(--field);
      cursor: pointer;
      font-weight: 800;
      list-style: none;
    }

    .info summary::-webkit-details-marker {
      display: none;
    }

    .info-panel {
      position: absolute;
      right: 0;
      top: 34px;
      z-index: 4;
      width: min(340px, calc(100vw - 48px));
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      color: var(--ink);
      background: var(--surface);
      box-shadow: 0 18px 40px var(--shadow-soft);
      font-size: 13px;
    }

    .info-panel p {
      margin: 0;
    }

    .info-panel p + p {
      margin-top: 8px;
    }

    .inline {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--ink);
    }

    .inline input {
      width: 18px;
      min-height: 18px;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 6px;
    }

    .discovery {
      display: grid;
      gap: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: var(--subtle);
    }

    .discovery:empty {
      display: none;
    }

    .candidate {
      display: grid;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: var(--field);
    }

    .candidate-topline {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
    }

    .candidate-meta {
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 10;
      display: none;
      place-items: center;
      padding: 20px;
      background: var(--overlay);
    }

    .modal-backdrop.open {
      display: grid;
    }

    .modal {
      width: min(440px, 100%);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
      background: var(--surface);
      box-shadow: 0 24px 70px var(--shadow-strong);
    }

    .modal form {
      display: grid;
      grid-template-columns: 1fr;
    }

    .modal-title {
      display: flex;
      justify-content: space-between;
      align-items: start;
      gap: 12px;
      margin-bottom: 12px;
    }

    .modal-title h2 {
      margin-bottom: 4px;
    }

    .modal-summary {
      color: var(--muted);
      font-size: 13px;
      overflow-wrap: anywhere;
    }

    .round-trip-route {
      display: grid;
      gap: 8px;
      margin: 12px 0;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--subtle);
    }

    .route-line {
      display: grid;
      grid-template-columns: 48px 1fr;
      gap: 8px;
      font-size: 13px;
    }

    .route-line span:first-child {
      color: var(--muted);
      font-weight: 700;
    }

    .route-line span:last-child {
      overflow-wrap: anywhere;
    }

    .round-trip-progress {
      height: 8px;
      margin-top: 12px;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--progress-track);
    }

    .round-trip-progress-bar {
      width: 0%;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), var(--ok));
      transition: width 240ms ease;
    }

    .round-trip-steps {
      display: grid;
      gap: 8px;
      margin: 12px 0 0;
      padding: 0;
      list-style: none;
    }

    .round-trip-steps li {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 28px;
      color: var(--muted);
      font-size: 13px;
    }

    .step-dot {
      width: 10px;
      height: 10px;
      flex: 0 0 auto;
      border: 1px solid var(--line);
      border-radius: 50%;
      background: var(--field);
    }

    .step-active {
      color: var(--ink);
      font-weight: 700;
    }

    .step-active .step-dot {
      border-color: var(--accent);
      border-top-color: transparent;
      background: var(--field);
      animation: round-trip-spin 760ms linear infinite;
    }

    .step-done {
      color: var(--ok);
      font-weight: 700;
    }

    .step-done .step-dot {
      border-color: var(--ok);
      background: var(--ok);
    }

    .step-failed {
      color: var(--warn);
      font-weight: 700;
    }

    .step-failed .step-dot {
      border-color: var(--warn);
      background: var(--warn);
    }

    @keyframes round-trip-spin {
      to { transform: rotate(360deg); }
    }

    .modal-close {
      width: 34px;
      min-height: 34px;
      padding: 0;
      font-size: 18px;
      line-height: 1;
    }

    .verified #password-row,
    .verified #test-current {
      display: none;
    }

    body:not(.paid) .paid-only {
      display: none !important;
    }

    .switch-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: var(--subtle);
    }

    button {
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px 13px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      color: var(--ink);
      background: var(--field);
    }

    button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: var(--on-accent);
    }

    button.primary:hover { background: var(--accent-dark); }
    button:hover { border-color: var(--accent); }

    button.compact {
      min-height: 30px;
      padding: 5px 9px;
      font-size: 12px;
      font-weight: 700;
    }

    .accounts {
      display: grid;
      gap: 10px;
    }

    .account {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      display: grid;
      gap: 10px;
      background: var(--subtle);
    }

    .account-title {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
    }

    .account strong {
      overflow-wrap: anywhere;
    }

    .account small {
      color: var(--muted);
      overflow-wrap: anywhere;
    }

    .account-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .pill {
      border-radius: 999px;
      padding: 3px 8px;
      background: var(--chip);
      color: var(--accent-dark);
      font-size: 12px;
      white-space: nowrap;
    }

    .message {
      margin-top: 14px;
      min-height: 22px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }

    .message-details {
      margin-top: 8px;
      display: grid;
      gap: 4px;
      font-size: 13px;
      color: var(--muted);
    }

    .message-details div {
      overflow-wrap: anywhere;
    }

    .message-details ul {
      margin: 4px 0 0 18px;
      padding: 0;
    }

    .message.ok { color: var(--ok); }
    .message.warn { color: var(--warn); }

    @media (max-width: 860px) {
      header, .layout {
        display: block;
      }

      .brand-lockup {
        align-items: flex-start;
      }

      .status {
        margin-top: 12px;
        text-align: left;
      }

      .layout section + section {
        margin-top: 18px;
      }

      form {
        grid-template-columns: 1fr;
      }

      .span-2 { grid-column: auto; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="brand-lockup">
        <img src="/assets/imap-plugin-logo-square.png" alt="">
        <div>
          <h1>IMAP Mailboxes</h1>
          <p class="subhead">Configure mailbox profiles, test login, and keep secrets in your computer's secure credential store.</p>
        </div>
      </div>
      <div class="status">
        <strong>Setup UI ${SETUP_UI_VERSION}</strong>
        <span id="status">Local setup server ready</span>
        <button class="compact" type="button" id="reload-page">Reload</button>
      </div>
    </header>

    <div class="layout">
      <section>
        <h2>Connection</h2>
        <div class="switch-row paid-only">
          <div>
            <strong>SMTP sending</strong>
            <div class="help-text">Allow paid tools to send, reply, and run round-trip email tests.</div>
          </div>
          <label class="inline">
            <input id="smtpActionsEnabled" type="checkbox">
            Enabled
          </label>
        </div>
        <form id="account-form">
          <label class="span-2">Email address
            <input id="email" name="email" type="email" autocomplete="email" required placeholder="me@example.com">
          </label>
          <div class="actions span-2">
            <button type="button" id="discover-settings">Detect settings</button>
          </div>
          <div class="discovery span-2" id="discovery"></div>
          <label>Profile name
            <input id="accountId" name="accountId" autocomplete="off" required pattern="[A-Za-z0-9_-]+" placeholder="personal">
          </label>
          <label>Username
            <input id="username" name="username" autocomplete="username" required placeholder="me@example.com">
          </label>
          <label>IMAP Host
            <input id="host" name="host" required placeholder="imap.example.com">
          </label>
          <label>Port
            <input id="port" name="port" type="number" min="1" max="65535" required value="993">
          </label>
          <label class="inline">
            <input id="secure" name="secure" type="checkbox" checked>
            Use TLS
          </label>
          <div class="span-2 paid-only">
            <h2>SMTP Actions</h2>
            <div class="help-text">Optional. Leave blank to derive SMTP settings from the IMAP account and reuse the same saved password.</div>
          </div>
          <label class="paid-only">SMTP Host
            <input id="smtpHost" name="smtpHost" placeholder="smtp.example.com">
          </label>
          <label class="paid-only">SMTP Port
            <input id="smtpPort" name="smtpPort" type="number" min="1" max="65535" placeholder="587">
          </label>
          <label class="paid-only">SMTP Username
            <input id="smtpUsername" name="smtpUsername" autocomplete="username" placeholder="same as IMAP username">
          </label>
          <label class="inline paid-only">
            <input id="smtpSecure" name="smtpSecure" type="checkbox">
            SMTP implicit TLS
          </label>
          <div class="credential-card span-2">
            <div class="credential-topline">
              <div>
                <strong>Credential storage: Local keychain</strong>
                <div class="help-text">V1 stores the mailbox password in your operating system's secure credential store.</div>
              </div>
              <details class="info">
                <summary aria-label="What is a keychain?">i</summary>
                <div class="info-panel">
                  <p><strong>A keychain</strong> is the secure password vault built into your computer, such as Windows Credential Manager or macOS Keychain.</p>
                  <p>IMAP Mailboxes saves the password there instead of writing it into the account profile file. Codex receives the secret only when it needs to test or read the mailbox.</p>
                  <p>Use an app password when your email provider supports one.</p>
                </div>
              </details>
            </div>
          </div>
          <label id="password-row" class="span-2">
            <span class="field-heading">Password or app password</span>
            <input id="password" name="password" type="password" autocomplete="current-password" placeholder="Required for new accounts">
            <span class="help-text">Leave blank when editing an existing profile to keep the saved password unchanged.</span>
          </label>
          <div class="actions span-2">
            <button class="primary" type="submit">Save account</button>
            <button type="button" id="test-current">Test connection</button>
            <button class="paid-only" type="button" id="round-trip-current">Round-trip test</button>
            <button type="reset">Clear</button>
          </div>
        </form>
        <div class="message" id="message"></div>
      </section>

      <section>
        <h2>Accounts</h2>
        <div class="accounts" id="accounts"></div>
      </section>
    </div>

    <div class="modal-backdrop" id="test-modal" role="dialog" aria-modal="true" aria-labelledby="test-modal-title">
      <div class="modal">
        <div class="modal-title">
          <div>
            <h2 id="test-modal-title">Test Connection</h2>
            <div class="modal-summary" id="test-modal-summary"></div>
          </div>
          <button class="modal-close" type="button" id="close-test-modal" aria-label="Close">x</button>
        </div>
        <form id="test-modal-form">
          <label>Username
            <input id="modal-username" name="username" autocomplete="username" required>
          </label>
          <label>Password or app password
            <input id="modal-password" name="password" type="password" autocomplete="current-password" required>
          </label>
          <div class="actions">
            <button class="primary" type="submit">Test connection</button>
            <button type="button" id="cancel-test-modal">Cancel</button>
          </div>
        </form>
        <div class="message" id="modal-message"></div>
      </div>
    </div>

    <div class="modal-backdrop" id="round-trip-modal" role="dialog" aria-modal="true" aria-labelledby="round-trip-modal-title">
      <div class="modal">
        <div class="modal-title">
          <div>
            <h2 id="round-trip-modal-title">Round-trip test</h2>
            <div class="modal-summary" id="round-trip-modal-summary"></div>
          </div>
          <button class="modal-close" type="button" id="close-round-trip-modal" aria-label="Close">x</button>
        </div>
        <div class="round-trip-route">
          <div class="route-line"><span>From</span><span id="round-trip-from"></span></div>
          <div class="route-line"><span>To</span><span id="round-trip-to"></span></div>
        </div>
        <div class="actions">
          <button class="primary" type="button" id="start-round-trip">Start</button>
          <button type="button" id="cancel-round-trip">Cancel</button>
        </div>
        <div class="round-trip-progress" aria-hidden="true">
          <div class="round-trip-progress-bar" id="round-trip-progress-bar"></div>
        </div>
        <ol class="round-trip-steps" id="round-trip-steps"></ol>
        <div class="message" id="round-trip-message"></div>
      </div>
    </div>
  </main>

  <script>
    const TOKEN = ${tokenJson};
    const SETUP_UI_VERSION = ${setupVersionJson};
    const SERVER_PID = ${processIdJson};
    const headers = { "content-type": "application/json", "x-imap-plugin-token": TOKEN };
    const form = document.querySelector("#account-form");
    const message = document.querySelector("#message");
    const accountsEl = document.querySelector("#accounts");
    const statusEl = document.querySelector("#status");
    const discoveryEl = document.querySelector("#discovery");
    const testModal = document.querySelector("#test-modal");
    const testModalForm = document.querySelector("#test-modal-form");
    const modalMessage = document.querySelector("#modal-message");
    const roundTripModal = document.querySelector("#round-trip-modal");
    const roundTripMessage = document.querySelector("#round-trip-message");
    const roundTripStepsEl = document.querySelector("#round-trip-steps");
    const roundTripProgressBar = document.querySelector("#round-trip-progress-bar");
    const startRoundTripButton = document.querySelector("#start-round-trip");
    const cancelRoundTripButton = document.querySelector("#cancel-round-trip");
    let paidActions = false;
    let smtpActionsEnabled = false;
    let pendingCandidate = null;
    let pendingEmail = "";
    let pendingRoundTrip = null;
    let roundTripRunning = false;

    const roundTripStepLabels = [
      ["sending", "Sending email"],
      ["sent", "Email sent."],
      ["searching", "Searching round trip email"],
      ["found", "Round trip email found."],
      ["marking-read", "Marking email read."],
      ["successful", "Round trip successful."]
    ];

    function setMessage(text, kind = "", details = null) {
      message.textContent = "";
      message.className = "message " + kind;
      const summary = document.createElement("div");
      summary.textContent = text;
      message.appendChild(summary);

      if (details) {
        message.appendChild(details);
      }

      statusEl.textContent = text || "Local setup server ready";
    }

    function setModalMessage(text, kind = "", details = null) {
      modalMessage.textContent = "";
      modalMessage.className = "message " + kind;
      const summary = document.createElement("div");
      summary.textContent = text;
      modalMessage.appendChild(summary);

      if (details) {
        modalMessage.appendChild(details);
      }
    }

    function setRoundTripMessage(text, kind = "", details = null) {
      roundTripMessage.textContent = "";
      roundTripMessage.className = "message " + kind;
      const summary = document.createElement("div");
      summary.textContent = text;
      roundTripMessage.appendChild(summary);

      if (details) {
        roundTripMessage.appendChild(details);
      }
    }

    function renderRoundTripSteps(steps = [], activeId = "") {
      const byId = new Map(steps.map((step) => [step.id, step]));
      roundTripStepsEl.textContent = "";

      for (const [id, label] of roundTripStepLabels) {
        const status = byId.get(id)?.status || (id === activeId ? "active" : "pending");
        const item = document.createElement("li");
        item.className = "step-" + status;

        const dot = document.createElement("span");
        dot.className = "step-dot";
        dot.setAttribute("aria-hidden", "true");

        const text = document.createElement("span");
        text.textContent = byId.get(id)?.label || label;

        item.appendChild(dot);
        item.appendChild(text);
        roundTripStepsEl.appendChild(item);
      }

      updateRoundTripProgress(steps, activeId);
    }

    function updateRoundTripProgress(steps = [], activeId = "") {
      const total = roundTripStepLabels.length;
      const doneCount = steps.filter((step) => step.status === "done").length;
      const failedIndex = steps.findIndex((step) => step.status === "failed");
      const activeIndex = roundTripStepLabels.findIndex(([id]) => id === activeId);
      const currentIndex = failedIndex >= 0 ? failedIndex : activeIndex;
      const progressUnits = Math.max(doneCount, currentIndex >= 0 ? currentIndex + 0.45 : 0);
      const percent = Math.max(0, Math.min(100, Math.round((progressUnits / total) * 100)));
      roundTripProgressBar.style.width = percent + "%";
    }

    function previewRoundTripFromAccount(account) {
      return {
        from: account.smtpUsername || account.username,
        to: account.email || account.username
      };
    }

    function previewRoundTripFromPayload(payload) {
      return {
        from: payload.smtpUsername || payload.username,
        to: payload.email || payload.username
      };
    }

    function openRoundTripModal(config) {
      pendingRoundTrip = config;
      roundTripRunning = false;
      document.querySelector("#round-trip-modal-summary").textContent = config.title;
      document.querySelector("#round-trip-from").textContent = config.from;
      document.querySelector("#round-trip-to").textContent = config.to;
      startRoundTripButton.disabled = false;
      cancelRoundTripButton.disabled = false;
      cancelRoundTripButton.textContent = "Cancel";
      renderRoundTripSteps();
      setRoundTripMessage("");
      roundTripModal.classList.add("open");
      startRoundTripButton.focus();
    }

    function closeRoundTripModal() {
      if (roundTripRunning) {
        return;
      }

      pendingRoundTrip = null;
      roundTripModal.classList.remove("open");
    }

    async function startPendingRoundTrip() {
      if (!pendingRoundTrip || roundTripRunning) {
        return;
      }

      roundTripRunning = true;
      startRoundTripButton.disabled = true;
      cancelRoundTripButton.disabled = true;
      renderRoundTripSteps([], "sending");
      setRoundTripMessage("Sending email...");
      setMessage("Running round-trip test...");

      try {
        const result = await pendingRoundTrip.run();
        renderRoundTripSteps(result.steps || [], "");
        const success = Boolean(result.found);
        const text = success ? "Round trip successful." : result.message;
        setRoundTripMessage(text, success ? "ok" : "warn");
        setMessage(
          success ? "Round-trip succeeded via " + result.recipient + "." : result.message,
          success ? "ok" : "warn"
        );
      } catch (error) {
        const failure = formatClientFailure(error);
        renderRoundTripSteps([{ id: "sending", label: "Sending email", status: "failed" }], "");
        setRoundTripMessage(failure.error, "warn", diagnosticDetails(error.diagnostic || failure.diagnostic));
        setMessage(failure.error, "warn", diagnosticDetails(error.diagnostic || failure.diagnostic));
      } finally {
        roundTripRunning = false;
        cancelRoundTripButton.disabled = false;
        cancelRoundTripButton.textContent = "Close";
      }
    }

    function diagnosticDetails(diagnostic) {
      if (!diagnostic) {
        return null;
      }

      const details = document.createElement("div");
      details.className = "message-details";

      function addLine(label, value) {
        if (!value) {
          return;
        }

        const line = document.createElement("div");
        line.textContent = label + ": " + value;
        details.appendChild(line);
      }

      addLine("Category", diagnostic.category);
      addLine("Code", diagnostic.code || diagnostic.responseStatus);
      addLine("Server response", diagnostic.response);
      addLine("Original error", diagnostic.originalMessage);

      if (diagnostic.account) {
        const secureText = diagnostic.account.secure ? "TLS on" : "TLS off";
        addLine("Attempted", diagnostic.account.username + " at " + diagnostic.account.host + ":" + diagnostic.account.port + " (" + secureText + ")");
      }

      if (diagnostic.suggestions && diagnostic.suggestions.length) {
        const list = document.createElement("ul");
        for (const suggestion of diagnostic.suggestions) {
          const item = document.createElement("li");
          item.textContent = suggestion;
          list.appendChild(item);
        }
        details.appendChild(list);
      }

      return details.childElementCount ? details : null;
    }

    function formatClientFailure(error) {
      if (error instanceof TypeError) {
        return {
          error: "The setup page could not reach the local plugin server. Reload the page and reopen the setup URL if needed.",
          diagnostic: {
            category: "setup-server",
            originalMessage: error.message,
            suggestions: [
              "Click Reload on this page.",
              "Ask Codex to open the IMAP setup page again if the local server stopped."
            ]
          }
        };
      }

      return {
        error: error && error.message ? error.message : "Command failed.",
        diagnostic: null
      };
    }

    document.title = "IMAP Mailboxes Setup " + SETUP_UI_VERSION;
    console.info("IMAP Mailboxes setup UI", { version: SETUP_UI_VERSION, pid: SERVER_PID });

    function accountIdFromEmail(email) {
      return email
        .trim()
        .toLowerCase()
        .replace(/@/g, "-")
        .replace(/[^a-z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48);
    }

    function clearVerifiedState() {
      form.classList.remove("verified");
    }

    function applyCandidate(candidate, email, username, password) {
      const accountId = accountIdFromEmail(email);
      if (!document.querySelector("#accountId").value.trim()) {
        document.querySelector("#accountId").value = accountId;
      }
      document.querySelector("#username").value = username || candidate.username || email;
      document.querySelector("#host").value = candidate.host;
      document.querySelector("#port").value = candidate.port;
      document.querySelector("#secure").checked = candidate.secure;
      document.querySelector("#smtpHost").value = candidate.host.replace(/^imap\\./i, "smtp.");
      document.querySelector("#smtpPort").value = "587";
      document.querySelector("#smtpUsername").value = username || candidate.username || email;
      document.querySelector("#smtpSecure").checked = false;
      document.querySelector("#password").value = password || "";
      form.classList.add("verified");
      setMessage("Connection succeeded for " + candidate.provider + ". Save the account to keep these settings.", "ok");
    }

    function openTestModal(candidate, email) {
      pendingCandidate = candidate;
      pendingEmail = email;
      document.querySelector("#test-modal-summary").textContent = candidate.host + ":" + candidate.port + " (" + (candidate.secure ? "TLS on" : "TLS off") + ")";
      document.querySelector("#modal-username").value = document.querySelector("#username").value.trim() || candidate.username || email;
      document.querySelector("#modal-password").value = "";
      setModalMessage("");
      testModal.classList.add("open");
      document.querySelector("#modal-password").focus();
    }

    function closeTestModal() {
      pendingCandidate = null;
      pendingEmail = "";
      document.querySelector("#modal-password").value = "";
      testModal.classList.remove("open");
    }

    function renderDiscovery(result) {
      discoveryEl.textContent = "";

      const heading = document.createElement("strong");
      heading.textContent = result.provider
        ? "Detected " + result.provider
        : "Detected possible IMAP settings";
      discoveryEl.appendChild(heading);

      if (result.mx && result.mx.length) {
        const mx = document.createElement("div");
        mx.className = "candidate-meta";
        mx.textContent = "MX: " + result.mx.slice(0, 3).map((entry) => entry.exchange + " (" + entry.priority + ")").join(", ");
        discoveryEl.appendChild(mx);
      }

      if (result.warnings && result.warnings.length) {
        for (const warning of result.warnings) {
          const line = document.createElement("div");
          line.className = "candidate-meta";
          line.textContent = warning;
          discoveryEl.appendChild(line);
        }
      }

      if (!result.candidates.length) {
        const empty = document.createElement("div");
        empty.className = "candidate-meta";
        empty.textContent = "No IMAP candidates were detected. Use the manual settings below.";
        discoveryEl.appendChild(empty);
        return;
      }

      result.candidates.forEach((candidate, index) => {
        const item = document.createElement("div");
        item.className = "candidate";
        item.innerHTML = \`
          <div class="candidate-topline">
            <strong></strong>
            <span class="pill"></span>
          </div>
          <div class="candidate-meta"></div>
          <div class="candidate-meta"></div>
          <div>
            <button type="button" class="compact">Test connection</button>
          </div>
        \`;
        item.querySelector("strong").textContent = candidate.provider;
        item.querySelector(".pill").textContent = Math.round(candidate.confidence * 100) + "% " + candidate.source;
        item.querySelectorAll(".candidate-meta")[0].textContent = candidate.username + " at " + candidate.host + ":" + candidate.port + " (" + (candidate.secure ? "TLS on" : "TLS off") + ")";
        item.querySelectorAll(".candidate-meta")[1].textContent = (candidate.resolves ? "Host resolves. " : "Host did not resolve yet. ") + (candidate.note || "");
        item.querySelector("button").addEventListener("click", () => openTestModal(candidate, result.email));
        discoveryEl.appendChild(item);
      });
    }

    function formPayload() {
      const email = document.querySelector("#email").value.trim();
      const payload = {
        accountId: document.querySelector("#accountId").value.trim() || accountIdFromEmail(email),
        email: email || undefined,
        host: document.querySelector("#host").value.trim(),
        port: Number(document.querySelector("#port").value),
        secure: document.querySelector("#secure").checked,
        username: document.querySelector("#username").value.trim() || email,
        credentialProvider: "local-keychain",
        password: document.querySelector("#password").value || undefined
      };
      if (paidActions) {
        payload.smtpHost = document.querySelector("#smtpHost").value.trim() || undefined;
        payload.smtpPort = document.querySelector("#smtpPort").value ? Number(document.querySelector("#smtpPort").value) : undefined;
        payload.smtpSecure = document.querySelector("#smtpSecure").checked;
        payload.smtpUsername = document.querySelector("#smtpUsername").value.trim() || undefined;
      }
      return payload;
    }

    async function api(path, options = {}) {
      const response = await fetch(path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
      const contentType = response.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await response.json()
        : { error: await response.text() || "Request failed." };
      if (!response.ok) {
        const error = new Error(payload.error || "Request failed.");
        error.diagnostic = payload.diagnostic || null;
        throw error;
      }
      return payload;
    }

    async function loadAccounts() {
      const { accounts } = await api("/api/accounts");
      accountsEl.innerHTML = "";
      if (!accounts.length) {
        accountsEl.innerHTML = "<small>No accounts configured yet.</small>";
        return;
      }

      for (const account of accounts) {
        const item = document.createElement("div");
        item.className = "account";
        item.innerHTML = \`
          <div class="account-title">
            <strong></strong>
            <span class="pill"></span>
          </div>
          <small></small>
          <div class="account-actions">
            <button type="button" data-action="test">Test</button>
            <button class="paid-only" type="button" data-action="round-trip">Round-trip</button>
            <button type="button" data-action="edit">Edit</button>
            <button type="button" data-action="remove">Remove</button>
          </div>
        \`;
        item.querySelector("strong").textContent = account.id;
        item.querySelector(".pill").textContent = "Local keychain";
        item.querySelector("small").textContent = (account.email || account.username) + " as " + account.username + " at " + account.host + ":" + account.port
          + (account.smtpHost ? " / SMTP " + account.smtpHost + ":" + (account.smtpPort || 587) : "");
        item.querySelector('[data-action="test"]').addEventListener("click", async () => {
          setMessage("Testing " + account.id + "...");
          try {
            await api("/api/accounts/" + encodeURIComponent(account.id) + "/test", { method: "POST" });
            setMessage("Connection succeeded for " + account.id + ".", "ok");
          } catch (error) {
            const failure = formatClientFailure(error);
            setMessage(failure.error, "warn", diagnosticDetails(error.diagnostic || failure.diagnostic));
          }
        });
        item.querySelector('[data-action="round-trip"]').addEventListener("click", async () => {
          const preview = previewRoundTripFromAccount(account);
          openRoundTripModal({
            title: "Saved account " + account.id,
            from: preview.from,
            to: preview.to,
            run: () => api("/api/accounts/" + encodeURIComponent(account.id) + "/round-trip", { method: "POST" })
          });
        });
        item.querySelector('[data-action="edit"]').addEventListener("click", () => {
          clearVerifiedState();
          document.querySelector("#email").value = account.email || (account.username.includes("@") ? account.username : "");
          document.querySelector("#accountId").value = account.id;
          document.querySelector("#username").value = account.username;
          document.querySelector("#host").value = account.host;
          document.querySelector("#port").value = account.port;
          document.querySelector("#secure").checked = account.secure;
          document.querySelector("#smtpHost").value = account.smtpHost || "";
          document.querySelector("#smtpPort").value = account.smtpPort || "";
          document.querySelector("#smtpSecure").checked = Boolean(account.smtpSecure);
          document.querySelector("#smtpUsername").value = account.smtpUsername || "";
          document.querySelector("#password").value = "";
          setMessage("Loaded " + account.id + " for editing.");
        });
        item.querySelector('[data-action="remove"]').addEventListener("click", async () => {
          setMessage("Removing " + account.id + "...");
          try {
            await api("/api/accounts/" + encodeURIComponent(account.id), { method: "DELETE" });
            setMessage("Removed " + account.id + ".", "ok");
            await loadAccounts();
          } catch (error) {
            const failure = formatClientFailure(error);
            setMessage(failure.error, "warn", diagnosticDetails(error.diagnostic || failure.diagnostic));
          }
        });
        accountsEl.appendChild(item);
      }
    }

    document.querySelector("#discover-settings").addEventListener("click", async () => {
      clearVerifiedState();
      const email = document.querySelector("#email").value.trim();
      setMessage("Detecting settings...");
      discoveryEl.textContent = "";
      try {
        const result = await api("/api/discover", { method: "POST", body: JSON.stringify({ email }) });
        renderDiscovery(result);
        setMessage(result.candidates.length ? "Settings detected. Test a candidate to apply it." : "No settings were detected.", result.candidates.length ? "ok" : "warn");
      } catch (error) {
        const failure = formatClientFailure(error);
        setMessage(failure.error, "warn", diagnosticDetails(error.diagnostic || failure.diagnostic));
      }
    });

    testModalForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!pendingCandidate) {
        return;
      }

      const username = document.querySelector("#modal-username").value.trim();
      const password = document.querySelector("#modal-password").value;
      setModalMessage("Testing connection...");
      try {
        await api("/api/test", {
          method: "POST",
          body: JSON.stringify({
            accountId: accountIdFromEmail(pendingEmail),
            host: pendingCandidate.host,
            port: pendingCandidate.port,
            secure: pendingCandidate.secure,
            username,
            credentialProvider: "local-keychain",
            password
          })
        });
        const testedCandidate = pendingCandidate;
        const testedEmail = pendingEmail;
        closeTestModal();
        applyCandidate(testedCandidate, testedEmail, username, password);
      } catch (error) {
        const failure = formatClientFailure(error);
        setModalMessage(failure.error, "warn", diagnosticDetails(error.diagnostic || failure.diagnostic));
      }
    });

    document.querySelector("#close-test-modal").addEventListener("click", closeTestModal);
    document.querySelector("#cancel-test-modal").addEventListener("click", closeTestModal);
    testModal.addEventListener("click", (event) => {
      if (event.target === testModal) {
        closeTestModal();
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      setMessage("Saving account...");
      try {
        await api("/api/accounts", { method: "POST", body: JSON.stringify(formPayload()) });
        setMessage("Account saved.", "ok");
        await loadAccounts();
      } catch (error) {
        const failure = formatClientFailure(error);
        setMessage(failure.error, "warn", diagnosticDetails(error.diagnostic || failure.diagnostic));
      }
    });
    document.querySelector("#test-current").addEventListener("click", async () => {
      setMessage("Testing connection...");
      try {
        await api("/api/test", { method: "POST", body: JSON.stringify(formPayload()) });
        setMessage("Connection succeeded.", "ok");
      } catch (error) {
        const failure = formatClientFailure(error);
        setMessage(failure.error, "warn", diagnosticDetails(error.diagnostic || failure.diagnostic));
      }
    });
    document.querySelector("#round-trip-current").addEventListener("click", async () => {
      const payload = formPayload();
      const preview = previewRoundTripFromPayload(payload);
      openRoundTripModal({
        title: "Current form settings",
        from: preview.from,
        to: preview.to,
        run: () => api("/api/round-trip", { method: "POST", body: JSON.stringify(payload) })
      });
    });
    document.querySelector("#close-round-trip-modal").addEventListener("click", closeRoundTripModal);
    cancelRoundTripButton.addEventListener("click", closeRoundTripModal);
    startRoundTripButton.addEventListener("click", startPendingRoundTrip);
    roundTripModal.addEventListener("click", (event) => {
      if (event.target === roundTripModal) {
        closeRoundTripModal();
      }
    });
    document.querySelector("#smtpActionsEnabled").addEventListener("change", async (event) => {
      const enabled = event.target.checked;
      setMessage(enabled ? "Enabling SMTP sending..." : "Disabling SMTP sending...");
      try {
        const { preferences } = await api("/api/preferences", {
          method: "POST",
          body: JSON.stringify({ smtpActionsEnabled: enabled })
        });
        smtpActionsEnabled = Boolean(preferences.smtpActionsEnabled);
        event.target.checked = smtpActionsEnabled;
        setMessage(smtpActionsEnabled ? "SMTP sending enabled." : "SMTP sending disabled.", "ok");
      } catch (error) {
        event.target.checked = smtpActionsEnabled;
        const failure = formatClientFailure(error);
        setMessage(failure.error, "warn", diagnosticDetails(error.diagnostic || failure.diagnostic));
      }
    });
    form.addEventListener("reset", () => setTimeout(() => {
      clearVerifiedState();
      discoveryEl.textContent = "";
      setMessage("");
    }));
    for (const selector of ["#email", "#username", "#host", "#port", "#secure", "#smtpHost", "#smtpPort", "#smtpSecure", "#smtpUsername", "#password"]) {
      document.querySelector(selector).addEventListener("input", clearVerifiedState);
      document.querySelector(selector).addEventListener("change", clearVerifiedState);
    }
    document.querySelector("#reload-page").addEventListener("click", () => {
      const url = new URL(window.location.href);
      url.searchParams.set("r", Date.now().toString());
      window.location.replace(url.toString());
    });

    async function loadSubscription() {
      const { subscription, preferences } = await api("/api/subscription");
      paidActions = Boolean(subscription.live);
      smtpActionsEnabled = Boolean(preferences && preferences.smtpActionsEnabled);
      document.body.classList.toggle("paid", paidActions);
      document.querySelector("#smtpActionsEnabled").checked = smtpActionsEnabled;
    }

    loadSubscription()
      .catch(() => {
        paidActions = false;
        document.body.classList.remove("paid");
      })
      .finally(() => loadAccounts().catch((error) => {
      const failure = formatClientFailure(error);
      setMessage(failure.error, "warn", diagnosticDetails(error.diagnostic || failure.diagnostic));
    }));
  </script>
</body>
</html>`;
}

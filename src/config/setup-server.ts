import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAccount, readAccounts, removeAccount, upsertAccount } from "./accounts.js";
import { publicAccount } from "./public-account.js";
import { createCredentialProvider } from "../credentials/index.js";
import { testAccount } from "../mail/imap-client.js";
import { AccountProfile } from "../types.js";
import { addAccountSchema } from "../tools/schemas.js";

export interface SetupServerInfo {
  url: string;
  host: string;
  port: number;
  token: string;
}

let setupServerPromise: Promise<SetupServerInfo> | undefined;

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(value, null, 2));
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
    host: input.host,
    port: input.port,
    secure: input.secure,
    username: input.username,
    credentialProvider: input.credentialProvider,
    credentialRef: input.credentialRef
  };
}

async function saveAccount(rawInput: unknown): Promise<AccountProfile> {
  const input = addAccountSchema.parse(rawInput);
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

async function testInputAccount(rawInput: unknown) {
  const input = addAccountSchema.parse(rawInput);
  const account = accountFromInput(input);
  const overridePassword = account.credentialProvider === "local-keychain" ? input.password : undefined;
  return testAccount(account, overridePassword);
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

    if (url.pathname === "/api/accounts" && request.method === "POST") {
      const account = await saveAccount(await readJson(request));
      sendJson(response, 200, { account: publicAccount(account) });
      return;
    }

    if (url.pathname === "/api/test" && request.method === "POST") {
      sendJson(response, 200, await testInputAccount(await readJson(request)));
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
      sendJson(response, 200, await testAccount(await getAccount(decodeURIComponent(testMatch[1]))));
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "Unknown error." });
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
        url: `http://${host}:${resolvedPort}/?token=${encodeURIComponent(token)}`
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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>IMAP Mailboxes Setup</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1f2933;
      --muted: #5f6f7a;
      --line: #d8e1e7;
      --surface: #ffffff;
      --page: #f5f7f4;
      --accent: #256d85;
      --accent-dark: #1f586d;
      --accent-soft: #e8f4f7;
      --ok: #1c7c54;
      --warn: #b85c38;
      --focus: #e1b12c;
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
      background: #fff;
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
      background: #fff;
    }

    input:focus, select:focus, button:focus {
      outline: 3px solid rgba(225, 177, 44, 0.35);
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
      background: #fff;
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
      background: #fff;
      box-shadow: 0 18px 40px rgba(31, 41, 51, 0.16);
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

    button {
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px 13px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      color: var(--ink);
      background: #fff;
    }

    button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }

    button.primary:hover { background: var(--accent-dark); }
    button:hover { border-color: var(--accent); }

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
      background: #fbfcfc;
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
      background: #e8f1f4;
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
      <div class="status" id="status">Local setup server ready</div>
    </header>

    <div class="layout">
      <section>
        <h2>Connection</h2>
        <form id="account-form">
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
  </main>

  <script>
    const TOKEN = ${tokenJson};
    const headers = { "content-type": "application/json", "x-imap-plugin-token": TOKEN };
    const form = document.querySelector("#account-form");
    const message = document.querySelector("#message");
    const accountsEl = document.querySelector("#accounts");
    const statusEl = document.querySelector("#status");

    function setMessage(text, kind = "") {
      message.textContent = text;
      message.className = "message " + kind;
      statusEl.textContent = text || "Local setup server ready";
    }

    function formPayload() {
      return {
        accountId: document.querySelector("#accountId").value.trim(),
        host: document.querySelector("#host").value.trim(),
        port: Number(document.querySelector("#port").value),
        secure: document.querySelector("#secure").checked,
        username: document.querySelector("#username").value.trim(),
        credentialProvider: "local-keychain",
        password: document.querySelector("#password").value || undefined
      };
    }

    async function api(path, options = {}) {
      const response = await fetch(path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Request failed.");
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
            <button type="button" data-action="edit">Edit</button>
            <button type="button" data-action="remove">Remove</button>
          </div>
        \`;
        item.querySelector("strong").textContent = account.id;
        item.querySelector(".pill").textContent = "Local keychain";
        item.querySelector("small").textContent = account.username + " at " + account.host + ":" + account.port;
        item.querySelector('[data-action="test"]').addEventListener("click", async () => {
          setMessage("Testing " + account.id + "...");
          try {
            await api("/api/accounts/" + encodeURIComponent(account.id) + "/test", { method: "POST" });
            setMessage("Connection succeeded for " + account.id + ".", "ok");
          } catch (error) {
            setMessage(error.message, "warn");
          }
        });
        item.querySelector('[data-action="edit"]').addEventListener("click", () => {
          document.querySelector("#accountId").value = account.id;
          document.querySelector("#username").value = account.username;
          document.querySelector("#host").value = account.host;
          document.querySelector("#port").value = account.port;
          document.querySelector("#secure").checked = account.secure;
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
            setMessage(error.message, "warn");
          }
        });
        accountsEl.appendChild(item);
      }
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      setMessage("Saving account...");
      try {
        await api("/api/accounts", { method: "POST", body: JSON.stringify(formPayload()) });
        setMessage("Account saved.", "ok");
        await loadAccounts();
      } catch (error) {
        setMessage(error.message, "warn");
      }
    });
    document.querySelector("#test-current").addEventListener("click", async () => {
      setMessage("Testing connection...");
      try {
        await api("/api/test", { method: "POST", body: JSON.stringify(formPayload()) });
        setMessage("Connection succeeded.", "ok");
      } catch (error) {
        setMessage(error.message, "warn");
      }
    });
    form.addEventListener("reset", () => setTimeout(() => {
      setMessage("");
    }));

    loadAccounts().catch((error) => setMessage(error.message, "warn"));
  </script>
</body>
</html>`;
}

const required = [
  "IMAP_PLUGIN_TRANSPORT",
  "IMAP_PLUGIN_CREDENTIAL_PROVIDER",
  "IMAP_PLUGIN_PUBLIC_BASE_URL",
  "IMAP_PLUGIN_SETUP_TOKEN"
];

const optional = [
  "IMAP_PLUGIN_ACCOUNT_STORE",
  "IMAP_PLUGIN_SQL_CONNECTION_STRING",
  "IMAP_PLUGIN_STRIPE_WEBHOOK_SECRET",
  "IMAP_PLUGIN_STRIPE_MAIL_ACTIONS_PRICE_IDS",
  "IMAP_PLUGIN_STRIPE_MAIL_ACTIONS_PRICE_ID",
  "IMAP_PLUGIN_STRIPE_SECRET_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_ID"
];

const missing = required.filter((name) => !process.env[name]?.trim());
const warnings = [];

if (process.env.IMAP_PLUGIN_TRANSPORT !== "http") {
  warnings.push('IMAP_PLUGIN_TRANSPORT should be "http" for Azure App Service.');
}

if (process.env.IMAP_PLUGIN_CREDENTIAL_PROVIDER === "local-keychain") {
  warnings.push('IMAP_PLUGIN_CREDENTIAL_PROVIDER must not be "local-keychain" on a public host.');
}

if (process.env.IMAP_PLUGIN_CREDENTIAL_PROVIDER === "dev-sql-vault" && process.env.NODE_ENV === "production") {
  warnings.push('IMAP_PLUGIN_CREDENTIAL_PROVIDER="dev-sql-vault" is intended for local development, not production.');
}

if (process.env.IMAP_PLUGIN_CREDENTIAL_PROVIDER === "sql-vault" && process.env.IMAP_PLUGIN_ACCOUNT_STORE !== "sql") {
  warnings.push('IMAP_PLUGIN_ACCOUNT_STORE must be "sql" when IMAP_PLUGIN_CREDENTIAL_PROVIDER="sql-vault".');
}

if (process.env.IMAP_PLUGIN_ACCOUNT_STORE === "sql" && !process.env.IMAP_PLUGIN_SQL_CONNECTION_STRING?.trim()) {
  warnings.push("IMAP_PLUGIN_SQL_CONNECTION_STRING is required when IMAP_PLUGIN_ACCOUNT_STORE=sql.");
}

if (!process.env.IMAP_PLUGIN_PUBLIC_BASE_URL?.startsWith("https://")) {
  warnings.push("IMAP_PLUGIN_PUBLIC_BASE_URL should be the public https://*.azurewebsites.net URL.");
}

for (const name of required) {
  console.log(`${process.env[name]?.trim() ? "ok" : "missing"} required ${name}`);
}

for (const name of optional) {
  console.log(`${process.env[name]?.trim() ? "ok" : "unset"} optional ${name}`);
}

for (const warning of warnings) {
  console.warn(`warning ${warning}`);
}

if (missing.length > 0 || warnings.length > 0) {
  process.exitCode = 1;
}

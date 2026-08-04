import { Command } from "commander";
import { cleanupConfig } from "./config/cleanup.js";
import { getAccount, readAccounts, removeAccount, upsertAccount } from "./config/accounts.js";
import { createCredentialProvider, credentialRefForAccount, defaultCredentialProviderKind, storesPassword } from "./credentials/index.js";
import { testAccount } from "./mail/imap-client.js";
import { AccountProfile, CredentialProviderKind } from "./types.js";

const program = new Command();

program
  .name("imap-plugin")
  .description("Manage IMAP Plugin accounts.")
  .version("0.1.0");

const account = program.command("account").description("Manage account profiles.");

program
  .command("cleanup")
  .option("--yes", "Confirm removal of local plugin config and local-keychain secrets.")
  .description("Remove all local plugin config files and local-keychain secrets.")
  .action(async (options) => {
    if (!options.yes) {
      throw new Error("Refusing to remove config without --yes.");
    }

    console.log(JSON.stringify(await cleanupConfig(), null, 2));
  });

account
  .command("list")
  .description("List configured accounts without secrets.")
  .action(async () => {
    const accounts = await readAccounts();
    console.log(JSON.stringify({ accounts }, null, 2));
  });

account
  .command("add")
  .argument("<accountId>")
  .requiredOption("--host <host>")
  .option("--port <port>", "IMAP port", "993")
  .option("--secure <secure>", "Use TLS", "true")
  .option("--email <email>", "Mailbox email address used for round-trip tests")
  .requiredOption("--username <username>")
  .option("--credential-provider <provider>", "local-keychain, 1password, env, or dev-sql-vault")
  .option("--credential-ref <ref>", "1Password op:// reference, environment variable name, or dev SQL vault secret reference")
  .option("--password <password>", "Password for local-keychain or dev-sql-vault storage")
  .option("--smtp-host <host>", "SMTP host for send/reply actions")
  .option("--smtp-port <port>", "SMTP port")
  .option("--smtp-secure <secure>", "Use implicit TLS for SMTP")
  .option("--smtp-username <username>", "SMTP username")
  .action(async (accountId: string, options) => {
    const credentialProvider = (options.credentialProvider ?? defaultCredentialProviderKind()) as CredentialProviderKind;
    const profile: AccountProfile = {
      id: accountId,
      email: options.email,
      host: options.host,
      port: Number(options.port),
      secure: options.secure === "true",
      username: options.username,
      credentialProvider,
      credentialRef: options.credentialRef,
      smtpHost: options.smtpHost,
      smtpPort: options.smtpPort ? Number(options.smtpPort) : undefined,
      smtpSecure: options.smtpSecure === undefined ? undefined : options.smtpSecure === "true",
      smtpUsername: options.smtpUsername
    };
    profile.credentialRef = credentialRefForAccount(profile);

    if (storesPassword(credentialProvider)) {
      if (!options.password) {
        throw new Error(`--password is required for ${credentialProvider} accounts.`);
      }

      await createCredentialProvider(credentialProvider).set?.(profile, options.password);
    }

    await upsertAccount(profile);
    console.log(JSON.stringify({ account: profile }, null, 2));
  });

account
  .command("remove")
  .argument("<accountId>")
  .description("Remove an account profile and local-keychain secret when applicable.")
  .action(async (accountId: string) => {
    const profile = await getAccount(accountId);
    await createCredentialProvider(profile.credentialProvider).delete?.(profile);
    const removed = await removeAccount(accountId);
    console.log(JSON.stringify({ removed }, null, 2));
  });

account
  .command("test")
  .argument("<accountId>")
  .description("Test account login.")
  .action(async (accountId: string) => {
    const result = await testAccount(await getAccount(accountId));
    console.log(JSON.stringify(result, null, 2));
  });

await program.parseAsync();

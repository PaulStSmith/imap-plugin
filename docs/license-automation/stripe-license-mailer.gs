/**
 * ByteForge Ltd. Stripe license mailer.
 *
 * Install:
 * 1. Create a Google Apps Script project.
 * 2. Paste this file into Code.gs.
 * 3. Paste secrets/licenses/byteforge-license-rsa-private-key.pem into CONFIG.privateKeyPem.
 * 4. Run installFiveMinuteTrigger() once and approve Gmail/Mail permissions.
 *
 * Google Apps Script has no native "email arrived" trigger, so this polls Gmail.
 */

const CONFIG = {
  companyName: "ByteForge Ltd.",
  productId: "imap-plugin",
  productName: "IMAP Plugin",
  licenseFileExtension: ".lic",

  adminEmail: "YOUR_ADMIN_EMAIL@example.com",
  replyToEmail: "YOUR_SUPPORT_EMAIL@example.com",

  // Keep this query narrow. Adjust subjects after seeing your real Stripe emails.
  stripeSearchQuery:
    'from:(stripe.com) newer_than:14d ("payment" OR "invoice" OR "subscription" OR "renewal")',
  processedLabelName: "ByteForge/LicenseProcessed",
  failedLabelName: "ByteForge/LicenseNeedsReview",

  licenseDays: 30,
  graceDays: 3,
  maxThreadsPerRun: 20,

  keyId: "byteforge-license-rs256-2026-08-03",
  signatureAlgorithm: "RS256",

  // Paste the full PEM block here in Apps Script only. Do not commit the real private key.
  privateKeyPem: String.raw`-----BEGIN PRIVATE KEY-----
PASTE_BYTEFORGE_RSA_PRIVATE_KEY_HERE
-----END PRIVATE KEY-----`,

  installInstructionsUrl: "",
};

function installFiveMinuteTrigger() {
  deleteLicenseMailerTriggers();

  ScriptApp.newTrigger("processStripeLicenseEmails")
    .timeBased()
    .everyMinutes(5)
    .create();
}

function deleteLicenseMailerTriggers() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === "processStripeLicenseEmails") {
      ScriptApp.deleteTrigger(trigger);
    }
  }
}

function processStripeLicenseEmails() {
  assertConfigured();

  const processedLabel = getOrCreateLabel(CONFIG.processedLabelName);
  const failedLabel = getOrCreateLabel(CONFIG.failedLabelName);
  const properties = PropertiesService.getScriptProperties();
  const query = `${CONFIG.stripeSearchQuery} -label:"${CONFIG.processedLabelName}"`;
  const threads = GmailApp.search(query, 0, CONFIG.maxThreadsPerRun);

  for (const thread of threads) {
    let threadHadSuccess = false;
    let threadHadFailure = false;

    for (const message of thread.getMessages()) {
      const messageKey = `processed:${message.getId()}`;
      if (properties.getProperty(messageKey)) {
        continue;
      }

      const parsed = parseStripeMessage(message);
      if (!parsed.ok) {
        notifyAdminFailure(message, parsed.reason);
        properties.setProperty(messageKey, `failed:${new Date().toISOString()}`);
        threadHadFailure = true;
        continue;
      }

      const license = buildSignedLicense(parsed.sale);
      sendLicenseEmail(parsed.sale.customerEmail, license);

      properties.setProperty(messageKey, `sent:${license.payload.licenseId}`);
      threadHadSuccess = true;
    }

    if (threadHadSuccess) {
      thread.addLabel(processedLabel);
    }

    if (threadHadFailure) {
      thread.addLabel(failedLabel);
    }
  }
}

function parseStripeMessage(message) {
  const subject = message.getSubject() || "";
  const from = message.getFrom() || "";
  const plainBody = message.getPlainBody() || "";
  const htmlBody = message.getBody() || "";
  const combined = `${subject}\n${from}\n${plainBody}\n${stripHtml(htmlBody)}`;

  if (!/stripe/i.test(from + " " + combined)) {
    return { ok: false, reason: "Message did not look like a Stripe email." };
  }

  if (!/(payment|paid|invoice|subscription|renewal|succeeded|successful)/i.test(combined)) {
    return { ok: false, reason: "Stripe email did not look like a sale or renewal." };
  }

  const customerEmail = extractCustomerEmail(combined);
  if (!customerEmail) {
    return { ok: false, reason: "Could not find a customer email address." };
  }

  const stripeReference =
    firstMatch(combined, /\b(?:pi|ch|in|cs|sub)_[A-Za-z0-9_]+\b/) ||
    firstMatch(combined, /\bReceipt\s*#?\s*([A-Za-z0-9-]+)/i) ||
    message.getId();

  return {
    ok: true,
    sale: {
      customerEmail: customerEmail.toLowerCase(),
      stripeReference,
      stripeMessageId: message.getId(),
      stripeSubject: subject,
      detectedAt: isoDateTime(new Date()),
    },
  };
}

function buildSignedLicense(sale) {
  const issuedAt = new Date();
  const validUntil = addDays(issuedAt, CONFIG.licenseDays);
  const graceUntil = addDays(validUntil, CONFIG.graceDays);
  const customerHash = sha256Hex(`${CONFIG.productId}:${sale.customerEmail}`);
  const licenseId = `BF-${sha256Hex(`${CONFIG.productId}:${sale.customerEmail}`).slice(0, 20).toUpperCase()}`;

  const payload = {
    schema: "byteforge-license-v1",
    issuer: CONFIG.companyName,
    product: CONFIG.productId,
    licenseId,
    plan: "monthly",
    status: "active",
    issuedAt: isoDateTime(issuedAt),
    validUntil: isoDate(validUntil),
    graceUntil: isoDate(graceUntil),
    customerHash: `sha256:${customerHash}`,
    source: {
      provider: "stripe-email",
      reference: sale.stripeReference,
      messageId: sale.stripeMessageId,
      detectedAt: sale.detectedAt,
    },
  };

  const signedPayload = canonicalJson(payload);
  const signatureBytes = Utilities.computeRsaSha256Signature(
    signedPayload,
    CONFIG.privateKeyPem,
    Utilities.Charset.UTF_8,
  );

  return {
    payload,
    signature: {
      algorithm: CONFIG.signatureAlgorithm,
      keyId: CONFIG.keyId,
      value: Utilities.base64EncodeWebSafe(signatureBytes),
    },
  };
}

function sendLicenseEmail(customerEmail, license) {
  const licenseId = license.payload.licenseId;
  const fileName = `${licenseId}${CONFIG.licenseFileExtension}`;
  const licenseJson = `${JSON.stringify(license, null, 2)}\n`;
  const blob = Utilities.newBlob(licenseJson, "application/json", fileName);
  const subject = `${CONFIG.productName} license ${licenseId}`;
  const textBody =
    `Thank you for purchasing ${CONFIG.productName}.\n\n` +
    `Your license file is attached: ${fileName}\n\n` +
    `Install instructions:\n` +
    `1. Save the attached .lic file somewhere you can find it.\n` +
    `2. Open Codex and configure the ${CONFIG.productName} plugin.\n` +
    `3. Choose the license import option and select this .lic file.\n` +
    `4. Restart the plugin if Codex asks you to.\n\n` +
    `This license is valid until ${license.payload.validUntil}, with grace until ${license.payload.graceUntil}.\n`;

  const htmlBody =
    `<p>Thank you for purchasing ${escapeHtml(CONFIG.productName)}.</p>` +
    `<p>Your license file is attached: <strong>${escapeHtml(fileName)}</strong></p>` +
    `<ol>` +
    `<li>Save the attached <code>.lic</code> file somewhere you can find it.</li>` +
    `<li>Open Codex and configure the ${escapeHtml(CONFIG.productName)} plugin.</li>` +
    `<li>Choose the license import option and select this <code>.lic</code> file.</li>` +
    `<li>Restart the plugin if Codex asks you to.</li>` +
    `</ol>` +
    `<p>This license is valid until <strong>${license.payload.validUntil}</strong>, with grace until <strong>${license.payload.graceUntil}</strong>.</p>` +
    optionalInstallLinkHtml();

  MailApp.sendEmail({
    to: customerEmail,
    replyTo: CONFIG.replyToEmail,
    subject,
    body: textBody,
    htmlBody,
    attachments: [blob],
  });
}

function notifyAdminFailure(message, reason) {
  MailApp.sendEmail({
    to: CONFIG.adminEmail,
    subject: `${CONFIG.productName} license email needs review`,
    body:
      `A Stripe email could not be processed automatically.\n\n` +
      `Reason: ${reason}\n` +
      `Subject: ${message.getSubject()}\n` +
      `From: ${message.getFrom()}\n` +
      `Message ID: ${message.getId()}\n` +
      `Date: ${message.getDate()}\n`,
  });
}

function extractCustomerEmail(text) {
  const emails = [...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
    .map((match) => match[0].toLowerCase())
    .filter((email) => !/@stripe\.com$/i.test(email))
    .filter((email) => !email.includes("noreply"))
    .filter((email) => !email.includes("no-reply"))
    .filter((email) => !email.includes("byteforge"));

  return emails[0] || "";
}

function getOrCreateLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function assertConfigured() {
  if (CONFIG.adminEmail.includes("YOUR_")) {
    throw new Error("Set CONFIG.adminEmail.");
  }

  if (CONFIG.replyToEmail.includes("YOUR_")) {
    throw new Error("Set CONFIG.replyToEmail.");
  }

  if (CONFIG.privateKeyPem.includes("PASTE_BYTEFORGE_RSA_PRIVATE_KEY_HERE")) {
    throw new Error("Paste CONFIG.privateKeyPem before running.");
  }
}

function sha256Hex(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map((byte) => (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, "0"))
    .join("");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function addDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function isoDate(date) {
  return Utilities.formatDate(date, "GMT", "yyyy-MM-dd");
}

function isoDateTime(date) {
  return Utilities.formatDate(date, "GMT", "yyyy-MM-dd'T'HH:mm:ss'Z'");
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function firstMatch(text, regex) {
  const match = text.match(regex);
  return match ? match[1] || match[0] : "";
}

function optionalInstallLinkHtml() {
  if (!CONFIG.installInstructionsUrl) {
    return "";
  }

  return `<p>Install guide: <a href="${escapeHtml(CONFIG.installInstructionsUrl)}">${escapeHtml(
    CONFIG.installInstructionsUrl,
  )}</a></p>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

import { createHash, createSign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const privateKeyPath = join(rootDir, "secrets", "licenses", "byteforge-license-rsa-private-key.pem");
const outputDir = join(rootDir, "secrets", "licenses");
const outputPath = join(outputDir, "byteforge-dev-super.lic");

const payload = {
  schema: "byteforge-license-v1",
  issuer: "ByteForge Ltd.",
  product: "imap-plugin",
  licenseId: "BF-DEV-SUPER-BYTEFORGE",
  plan: "developer",
  status: "active",
  licenseKind: "developer-super",
  neverExpires: true,
  features: ["*"],
  issuedAt: new Date().toISOString(),
  validUntil: "9999-12-31",
  graceUntil: "9999-12-31",
  customerHash: `sha256:${createHash("sha256").update("ByteForge Ltd.:developer-super").digest("hex")}`,
  source: {
    provider: "byteforge-dev",
    reference: "local-developer-license"
  }
};

const privateKey = readFileSync(privateKeyPath, "utf8");
const signer = createSign("RSA-SHA256");
signer.update(canonicalJson(payload), "utf8");
signer.end();

const license = {
  payload,
  signature: {
    algorithm: "RS256",
    keyId: "byteforge-license-rs256-2026-08-03",
    value: signer.sign(privateKey).toString("base64url")
  }
};

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(license, null, 2)}\n`, { mode: 0o600 });

console.log(`Created developer license: ${outputPath}`);

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

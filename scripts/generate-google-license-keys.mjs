import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const privateDir = join(rootDir, "secrets", "licenses");
const publicDir = join(rootDir, "assets", "licenses");

mkdirSync(privateDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: "spki",
    format: "pem",
  },
  privateKeyEncoding: {
    type: "pkcs8",
    format: "pem",
  },
});

const publicKeyFingerprint = createHash("sha256")
  .update(publicKey)
  .digest("hex")
  .match(/.{1,2}/g)
  .join(":");

const keyId = `byteforge-license-rs256-${new Date().toISOString().slice(0, 10)}`;

writeFileSync(join(privateDir, "byteforge-license-rsa-private-key.pem"), privateKey, {
  mode: 0o600,
});
writeFileSync(join(publicDir, "byteforge-license-rsa-public-key.pem"), publicKey);
writeFileSync(
  join(publicDir, "byteforge-license-rsa-public-key.json"),
  `${JSON.stringify(
    {
      keyId,
      company: "ByteForge Ltd.",
      algorithm: "RS256",
      usage: "google-apps-script-license-signature-verification",
      publicKeyPemFile: "byteforge-license-rsa-public-key.pem",
      publicKeySha256Fingerprint: publicKeyFingerprint,
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

console.log(`Created private key: ${join(privateDir, "byteforge-license-rsa-private-key.pem")}`);
console.log(`Created public key: ${join(publicDir, "byteforge-license-rsa-public-key.pem")}`);
console.log(`Created public metadata: ${join(publicDir, "byteforge-license-rsa-public-key.json")}`);
console.log(`Public key fingerprint: ${publicKeyFingerprint}`);

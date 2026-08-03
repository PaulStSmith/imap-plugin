import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const privateDir = join(rootDir, "secrets", "licenses");
const publicDir = join(rootDir, "assets", "licenses");

mkdirSync(privateDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ format: "pem", type: "spki" });
const privatePem = privateKey.export({ format: "pem", type: "pkcs8" });
const publicKeyFingerprint = createHash("sha256")
  .update(publicPem)
  .digest("hex")
  .match(/.{1,2}/g)
  .join(":");

const keyId = `byteforge-license-ed25519-${new Date().toISOString().slice(0, 10)}`;

writeFileSync(join(privateDir, "byteforge-license-private-key.pem"), privatePem, {
  mode: 0o600,
});
writeFileSync(join(publicDir, "byteforge-license-public-key.pem"), publicPem);
writeFileSync(
  join(publicDir, "byteforge-license-public-key.json"),
  `${JSON.stringify(
    {
      keyId,
      company: "ByteForge Ltd.",
      algorithm: "Ed25519",
      usage: "license-signature-verification",
      publicKeyPemFile: "byteforge-license-public-key.pem",
      publicKeySha256Fingerprint: publicKeyFingerprint,
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

console.log(`Created private key: ${join(privateDir, "byteforge-license-private-key.pem")}`);
console.log(`Created public key: ${join(publicDir, "byteforge-license-public-key.pem")}`);
console.log(`Created public metadata: ${join(publicDir, "byteforge-license-public-key.json")}`);
console.log(`Public key fingerprint: ${publicKeyFingerprint}`);

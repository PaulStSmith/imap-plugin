import { createVerify } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir } from "../config/accounts.js";

export type LicenseState = "active" | "grace" | "expired" | "invalid" | "missing";

export interface LicensePayload {
  schema: "byteforge-license-v1";
  issuer: "ByteForge Ltd.";
  product: "imap-plugin";
  licenseId: string;
  plan: string;
  status: "active" | "revoked";
  issuedAt: string;
  validUntil: string;
  graceUntil: string;
  customerHash: string;
  licenseKind?: string;
  neverExpires?: boolean;
  features?: string[];
  source?: {
    provider: string;
    reference?: string;
    messageId?: string;
    detectedAt?: string;
  };
}

export interface LicenseFile {
  payload: LicensePayload;
  signature: {
    algorithm: "RS256";
    keyId: string;
    value: string;
  };
}

export interface LicenseStatus {
  installed: boolean;
  live: boolean;
  state: LicenseState;
  path: string;
  license?: LicensePayload;
  reason?: string;
}

const PRODUCT_ID = "imap-plugin";
const ISSUER = "ByteForge Ltd.";
const LICENSE_FILE_NAME = "license.lic";
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnrzUvcYp1F1UAgzGPTcm
lM0R98FOLYutvlI1Wu/GsuwN5LUE9IAB8R8G9t4X6EB17+5Vg7t0KWHo1fQgQVdP
P61J8pTJSJCq/m+Xygq65U05OAh6ohoQRmRNaDA7xBEGm9UQKZK9pb30RoJPUOqv
x2rlP7PQkc0vj22aMXB/Tf6XriHIKPIWu+NPY2GMp0e/pHaJ1VToeKrr8AU0Gszd
ZEjy/cwnfARoxRbUXsQc0N/YDAIsyhjGfQ6rT7qn065x8ImdgDTAA9qBXvv1RSVh
OSymGRTXCv/WOMOZGstXFtn5iI9i7WTZDjX7/FCRqxAv0TgCTZjtihdsLz7Jxqof
2QIDAQAB
-----END PUBLIC KEY-----`;

export function installedLicensePath(): string {
  return join(configDir(), LICENSE_FILE_NAME);
}

export async function importLicenseFile(sourcePath: string): Promise<LicenseStatus> {
  const parsed = await readAndVerifyLicense(sourcePath);
  if (!parsed.live) {
    return parsed;
  }

  const targetPath = installedLicensePath();
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);

  return licenseStatus();
}

export async function licenseStatus(): Promise<LicenseStatus> {
  return readAndVerifyLicense(installedLicensePath());
}

async function readAndVerifyLicense(path: string): Promise<LicenseStatus> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        installed: false,
        live: false,
        state: "missing",
        path,
        reason: "No license file is installed."
      };
    }

    throw error;
  }

  try {
    const license = parseLicense(raw);
    const reason = validateLicenseShape(license) || validateSignature(license);
    if (reason) {
      return {
        installed: true,
        live: false,
        state: "invalid",
        path,
        reason
      };
    }

    return evaluateLicense(path, license.payload);
  } catch (error) {
    return {
      installed: true,
      live: false,
      state: "invalid",
      path,
      reason: error instanceof Error ? error.message : "License file could not be parsed."
    };
  }
}

function parseLicense(raw: string): LicenseFile {
  return JSON.parse(raw) as LicenseFile;
}

function validateLicenseShape(license: LicenseFile): string | undefined {
  if (!license || typeof license !== "object") {
    return "License file must be a JSON object.";
  }

  if (!license.payload || typeof license.payload !== "object") {
    return "License file is missing payload.";
  }

  if (!license.signature || typeof license.signature !== "object") {
    return "License file is missing signature.";
  }

  if (license.payload.schema !== "byteforge-license-v1") {
    return "License schema is not supported.";
  }

  if (license.payload.issuer !== ISSUER) {
    return "License issuer is not trusted.";
  }

  if (license.payload.product !== PRODUCT_ID) {
    return `License is for ${license.payload.product || "another product"}, not ${PRODUCT_ID}.`;
  }

  if (license.signature.algorithm !== "RS256") {
    return "License signature algorithm is not supported.";
  }

  if (!license.signature.value || typeof license.signature.value !== "string") {
    return "License signature value is missing.";
  }

  for (const [field, value] of Object.entries({
    licenseId: license.payload.licenseId,
    issuedAt: license.payload.issuedAt,
    validUntil: license.payload.validUntil,
    graceUntil: license.payload.graceUntil,
    customerHash: license.payload.customerHash
  })) {
    if (!value || typeof value !== "string") {
      return `License payload is missing ${field}.`;
    }
  }

  return undefined;
}

function validateSignature(license: LicenseFile): string | undefined {
  const verifier = createVerify("RSA-SHA256");
  verifier.update(canonicalJson(license.payload), "utf8");
  verifier.end();

  const ok = verifier.verify(PUBLIC_KEY_PEM, Buffer.from(license.signature.value, "base64url"));
  return ok ? undefined : "License signature is invalid.";
}

function evaluateLicense(path: string, license: LicensePayload): LicenseStatus {
  if (license.status === "revoked") {
    return {
      installed: true,
      live: false,
      state: "invalid",
      path,
      license,
      reason: "License has been revoked."
    };
  }

  const today = startOfUtcDay(new Date());
  const validUntil = parseUtcDate(license.validUntil);
  const graceUntil = parseUtcDate(license.graceUntil);

  if (license.neverExpires) {
    return {
      installed: true,
      live: true,
      state: "active",
      path,
      license
    };
  }

  if (!validUntil || !graceUntil) {
    return {
      installed: true,
      live: false,
      state: "invalid",
      path,
      license,
      reason: "License dates are invalid."
    };
  }

  if (today <= validUntil) {
    return {
      installed: true,
      live: true,
      state: "active",
      path,
      license
    };
  }

  if (today <= graceUntil) {
    return {
      installed: true,
      live: true,
      state: "grace",
      path,
      license,
      reason: "License is past its paid-through date but still inside the grace period."
    };
  }

  return {
    installed: true,
    live: false,
    state: "expired",
    path,
    license,
    reason: "License has expired."
  };
}

function parseUtcDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return undefined;
  }

  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999));
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

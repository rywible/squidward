import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { EncryptedEnvelope } from "./types";

function normalizeKey(masterKey: Uint8Array | string): Buffer {
  if (typeof masterKey === "string") {
    return createHash("sha256").update(masterKey, "utf8").digest();
  }

  if (masterKey.byteLength === 32) {
    return Buffer.from(masterKey);
  }

  return createHash("sha256").update(Buffer.from(masterKey)).digest();
}

export function encryptEnvelope(
  plaintext: Uint8Array | string,
  masterKey: Uint8Array | string,
  aad?: Uint8Array | string,
  keyRef?: string
): EncryptedEnvelope {
  const key = normalizeKey(masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const aadBuffer =
    typeof aad === "string" ? Buffer.from(aad, "utf8") : aad ? Buffer.from(aad) : undefined;

  if (aadBuffer) {
    cipher.setAAD(aadBuffer);
  }

  const plainBuffer =
    typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);

  const cipherText = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const envelope: EncryptedEnvelope = {
    alg: "aes-256-gcm",
    ivB64: iv.toString("base64"),
    cipherTextB64: cipherText.toString("base64"),
    authTagB64: authTag.toString("base64")
  };

  if (aadBuffer) {
    envelope.aadB64 = aadBuffer.toString("base64");
  }
  if (keyRef !== undefined) {
    envelope.keyRef = keyRef;
  }

  return envelope;
}

export function decryptEnvelope(
  envelope: EncryptedEnvelope,
  masterKey: Uint8Array | string,
  aad?: Uint8Array | string
): Uint8Array {
  if (envelope.alg !== "aes-256-gcm") {
    throw new Error(`Unsupported envelope algorithm: ${envelope.alg}`);
  }

  const key = normalizeKey(masterKey);
  const iv = Buffer.from(envelope.ivB64, "base64");
  const cipherText = Buffer.from(envelope.cipherTextB64, "base64");
  const authTag = Buffer.from(envelope.authTagB64, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);

  const aadBuffer =
    aad !== undefined
      ? typeof aad === "string"
        ? Buffer.from(aad, "utf8")
        : Buffer.from(aad)
      : envelope.aadB64
        ? Buffer.from(envelope.aadB64, "base64")
        : undefined;

  if (aadBuffer) {
    decipher.setAAD(aadBuffer);
  }

  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(cipherText), decipher.final()]);
}

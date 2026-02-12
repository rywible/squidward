import { describe, expect, test } from "bun:test";

import { decryptEnvelope, encryptEnvelope } from "../src/envelope";

describe("envelope encryption", () => {
  test("round-trips payload with aad", () => {
    const key = "local-dev-master-key";
    const aad = "scope:openai:run";
    const plaintext = JSON.stringify({ token: "secret-token", actor: "agent" });

    const encrypted = encryptEnvelope(plaintext, key, aad, "env://dev/local");
    const decrypted = decryptEnvelope(encrypted, key, aad);

    expect(new TextDecoder().decode(decrypted)).toBe(plaintext);
  });

  test("fails on wrong aad", () => {
    const encrypted = encryptEnvelope("sensitive", "master-key", "correct-aad");

    expect(() => decryptEnvelope(encrypted, "master-key", "incorrect-aad")).toThrow();
  });
});

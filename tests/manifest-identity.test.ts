import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const expectedExtensionId = "jgffclmbhhlgoloondkchodehenicfbl";

function extensionIdFromPublicKey(base64Der: string): string {
  const digest = createHash("sha256").update(Buffer.from(base64Der, "base64")).digest().subarray(0, 16);
  const alphabet = "abcdefghijklmnop";
  return [...digest].map((byte) => `${alphabet[byte >> 4]}${alphabet[byte & 0x0f]}`).join("");
}

describe("release extension identity", () => {
  it("pins the unpacked and CRX builds to the production allowlisted extension ID", async () => {
    const manifest = JSON.parse(await readFile(new URL("../src/manifest.json", import.meta.url), "utf8")) as {
      version?: string;
      key?: string;
    };

    expect(manifest.version).toBe("0.1.2");
    expect(manifest.key).toBeTypeOf("string");
    expect(extensionIdFromPublicKey(manifest.key ?? "")).toBe(expectedExtensionId);
  });
});

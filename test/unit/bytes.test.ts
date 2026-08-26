import { describe, expect, test } from "vitest";
import { decodeUtf8, encodeUtf8, sameBytes } from "../../src/render/bytes.js";

describe("passive byte helpers", () => {
  test("round-trip UTF-8 without normalizing bytes", () => {
    const bytes = encodeUtf8("来自 main 的留言\n");

    expect(decodeUtf8(bytes)).toBe("来自 main 的留言\n");
    expect(sameBytes(bytes, encodeUtf8("来自 main 的留言\n"))).toBe(true);
  });

  test("rejects invalid UTF-8 instead of repairing untrusted text", () => {
    expect(() => decodeUtf8(new Uint8Array([0xc3, 0x28]))).toThrow();
  });
});

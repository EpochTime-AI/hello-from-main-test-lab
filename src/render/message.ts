import { encodeUtf8 } from "./bytes.js";

export function renderPlainTextMessage(value: string): Uint8Array {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code !== undefined &&
      ((code >= 0 && code <= 8) ||
        code === 11 ||
        code === 12 ||
        (code >= 14 && code <= 31) ||
        (code >= 127 && code <= 159) ||
        code === 0x2028 ||
        code === 0x2029)
    ) {
      throw new Error("message contains forbidden control characters");
    }
  }
  return encodeUtf8(value);
}

import { encodeUtf8 } from "./bytes.js";

export function renderTraceBytes(value: unknown): Uint8Array {
  return encodeUtf8(`${JSON.stringify(value)}\n`);
}

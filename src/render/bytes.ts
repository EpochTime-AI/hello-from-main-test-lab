const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();

export function encodeUtf8(value: string): Uint8Array {
  return utf8Encoder.encode(value);
}

export function decodeUtf8(value: Uint8Array): string {
  return utf8Decoder.decode(value);
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }

  return true;
}

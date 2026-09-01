import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeBase32(value: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let output = "";
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let buffer = 0;
  const output: number[] = [];
  for (const character of normalized) {
    const index = ALPHABET.indexOf(character);
    if (index < 0) throw new Error("ADMIN_TOTP_SECRET is not valid Base32");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (!output.length) throw new Error("ADMIN_TOTP_SECRET is empty");
  return Buffer.from(output);
}

export function generateTotpSecret(bytes = 20): string {
  return encodeBase32(randomBytes(bytes));
}

export function totpCode(secret: string, timeMs = Date.now()): string {
  const counter = Math.floor(timeMs / 30_000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary =
    ((digest[offset] & 127) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

export function verifyTotp(
  code: string,
  secret: string,
  options: { timeMs?: number; window?: number } = {},
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const supplied = Buffer.from(code);
  const timeMs = options.timeMs ?? Date.now();
  const window = Math.min(Math.max(options.window ?? 1, 0), 1);
  for (let offset = -window; offset <= window; offset++) {
    const expected = Buffer.from(totpCode(secret, timeMs + offset * 30_000));
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected))
      return true;
  }
  return false;
}

export function totpAuthUri(secret: string, account: string, issuer: string): string {
  const label = `${issuer}:${account}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

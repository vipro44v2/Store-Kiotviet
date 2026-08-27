import { createHmac, timingSafeEqual } from "node:crypto";

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function verifyShopifyHmac(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  return safeEqual(createHmac("sha256", secret).update(rawBody, "utf8").digest("base64"), signature);
}
export function verifyKiotVietHmac(rawBody: string, signature: string | null, base64Secret: string): boolean {
  if (!signature || !base64Secret) return false;
  const keys = [Buffer.from(base64Secret, "base64"), Buffer.from(base64Secret, "utf8")];
  return keys.some((key) => {
    const hex = createHmac("sha256", key).update(rawBody, "utf8").digest("hex");
    const base64 = createHmac("sha256", key).update(rawBody, "utf8").digest("base64");
    return safeEqual(hex.toLowerCase(), signature.toLowerCase()) || safeEqual(base64, signature);
  });
}

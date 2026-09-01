import { describe, expect, it } from "vitest";
import { totpCode, verifyTotp } from "@/lib/auth/totp";

describe("TOTP", () => {
  it("matches the RFC 6238 SHA-1 test vector and permits only ±1 window", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(totpCode(secret, 59_000)).toBe("287082");
    const current = totpCode(secret, 90_000);
    expect(verifyTotp(current, secret, { timeMs: 60_000, window: 1 })).toBe(true);
    expect(verifyTotp(current, secret, { timeMs: 30_000, window: 1 })).toBe(false);
  });
});

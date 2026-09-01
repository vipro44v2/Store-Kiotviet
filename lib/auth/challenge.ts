import { SignJWT, jwtVerify } from "jose";
import { getEnv } from "@/lib/env";

export const TWO_FACTOR_COOKIE = "sk_sync_2fa";
export const TWO_FACTOR_MAX_ATTEMPTS = 5;
const encoder = new TextEncoder();

function signingSecret() {
  const secret = getEnv().SESSION_SECRET;
  if (secret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters");
  return encoder.encode(secret);
}

export interface TwoFactorChallenge {
  username: string;
  failures: number;
  expiresAt: number;
}

export async function createTwoFactorChallenge(
  username: string,
  failures = 0,
  expiresAt = Math.floor(Date.now() / 1000) + 300,
): Promise<string> {
  return new SignJWT({ purpose: "admin-2fa", failures })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(username)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .setIssuer("shopify-kiotviet-sync")
    .sign(signingSecret());
}

export async function verifyTwoFactorChallenge(token?: string): Promise<TwoFactorChallenge | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, signingSecret(), {
      issuer: "shopify-kiotviet-sync",
    });
    if (payload.purpose !== "admin-2fa" || !payload.sub || !payload.exp) return null;
    return {
      username: payload.sub,
      failures: Number(payload.failures ?? 0),
      expiresAt: payload.exp,
    };
  } catch {
    return null;
  }
}

export function challengeCookie(token: string, secure: boolean, maxAge = 300): string {
  return `${TWO_FACTOR_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearChallengeCookie(secure = false): string {
  return challengeCookie("", secure, 0);
}

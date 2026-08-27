import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/env";

export const SESSION_COOKIE = "sk_sync_session";
const encoder = new TextEncoder();
function secret() { const value = getEnv().SESSION_SECRET; if (value.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters"); return encoder.encode(value); }
export async function createSession(username: string): Promise<string> { return new SignJWT({ username, role: "admin" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").setIssuer("shopify-kiotviet-sync").sign(secret()); }
export async function verifySession(token?: string): Promise<boolean> { if (!token) return false; try { const { payload } = await jwtVerify(token, secret(), { issuer: "shopify-kiotviet-sync" }); return payload.role === "admin"; } catch { return false; } }
export async function isAuthenticated(): Promise<boolean> { return verifySession((await cookies()).get(SESSION_COOKIE)?.value); }

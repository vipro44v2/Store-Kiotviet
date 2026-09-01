import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { resetEnvForTests } from "@/lib/env";
import { createTwoFactorChallenge, TWO_FACTOR_COOKIE } from "@/lib/auth/challenge";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { totpCode } from "@/lib/auth/totp";
import { resetRateLimitsForTests } from "@/lib/security/rate-limit";

const cookieState = vi.hoisted(() => ({ challenge: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => name === "sk_sync_2fa" && cookieState.challenge
      ? { name, value: cookieState.challenge }
      : undefined,
  })),
}));

import { POST as passwordLogin } from "@/app/api/auth/login/route";
import { POST as verifyTwoFactor } from "@/app/api/auth/2fa/route";
import { proxy } from "@/proxy";

const origin = "http://localhost:3000";
const secret = "JBSWY3DPEHPK3PXP";

function login(username: string, password: string, ip = "10.0.0.1") {
  return passwordLogin(new Request(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ username, password }),
  }));
}

function verify(code: string, ip = "10.0.0.1") {
  return verifyTwoFactor(new Request(`${origin}/api/auth/2fa`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ code }),
  }));
}

function cookieFrom(response: Response, name: string): string | undefined {
  return response.headers.get("set-cookie")?.match(new RegExp(`${name}=([^;,]*)`))?.[1];
}

beforeEach(() => {
  process.env.APP_URL = origin;
  vi.stubEnv("NODE_ENV", "test");
  process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-characters";
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "correct-password";
  process.env.ADMIN_TOTP_SECRET = secret;
  process.env.REDIS_URL = "";
  cookieState.challenge = undefined;
  resetEnvForTests();
  resetRateLimitsForTests();
});

describe("admin two-factor login", () => {
  it("rejects an invalid username or password", async () => {
    const response = await login("wrong", "wrong");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ success: false, error: "Invalid credentials" });
  });

  it("keeps invalid-origin diagnostics server-side", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const response = await passwordLogin(new Request(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { origin: "https://untrusted.example", "content-type": "application/json" },
      body: JSON.stringify({ username: "private-admin", password: "private-password" }),
    }));
    expect(response.status).toBe(400);
    const body = JSON.stringify(await response.json());
    expect(body).toBe(JSON.stringify({ success: false, error: "Login failed" }));
    expect(body).not.toContain("private-admin");
    expect(body).not.toContain("private-password");
    expect(stderr.mock.calls.flat().join(" ")).toContain('"reason":"invalid_origin"');
    stderr.mockRestore();
  });

  it("does not expose malformed request details", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const response = await passwordLogin(new Request(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", "x-forwarded-for": "10.0.0.22" },
      body: JSON.stringify({ username: "private-admin", password: "" }),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ success: false, error: "Login failed" });
    const log = stderr.mock.calls.flat().join(" ");
    expect(log).toContain('"reason":"invalid_request"');
    expect(log).not.toContain("private-admin");
    expect(log).not.toContain("too_small");
    stderr.mockRestore();
  });

  it("keeps internal session configuration errors generic", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.SESSION_SECRET = "short";
    resetEnvForTests();
    const response = await login("admin", "correct-password", "10.0.0.23");
    expect(response.status).toBe(400);
    const body = JSON.stringify(await response.json());
    expect(body).toBe(JSON.stringify({ success: false, error: "Login failed" }));
    expect(body).not.toContain("SESSION_SECRET");
    expect(body).not.toContain("short");
    const log = stderr.mock.calls.flat().join(" ");
    expect(log).toContain('"reason":"session_configuration"');
    expect(log).not.toContain("short");
    stderr.mockRestore();
  });

  it("returns a temporary challenge after a valid password without a final session", async () => {
    const response = await login("admin", "correct-password");
    await expect(response.json()).resolves.toMatchObject({ requires2fa: true });
    expect(response.headers.get("set-cookie")).toContain(TWO_FACTOR_COOKIE);
    expect(response.headers.get("set-cookie")).not.toContain(SESSION_COOKIE);
  });

  it("rejects invalid TOTP and an expired challenge", async () => {
    cookieState.challenge = cookieFrom(await login("admin", "correct-password"), TWO_FACTOR_COOKIE);
    expect((await verify("000000")).status).toBe(401);
    cookieState.challenge = await createTwoFactorChallenge("admin", 0, Math.floor(Date.now() / 1000) - 1);
    expect((await verify(totpCode(secret))).status).toBe(401);
  });

  it("creates the final session only after valid TOTP and clears the challenge", async () => {
    cookieState.challenge = cookieFrom(await login("admin", "correct-password"), TWO_FACTOR_COOKIE);
    const response = await verify(totpCode(secret));
    expect(response.status).toBe(200);
    const cookies = response.headers.get("set-cookie") ?? "";
    expect(cookies).toContain(`${SESSION_COOKIE}=`);
    expect(cookies).toContain(`${TWO_FACTOR_COOKIE}=`);
    expect(cookies).toContain("Max-Age=0");
  });

  it("does not treat a temporary challenge as an authenticated admin session", async () => {
    cookieState.challenge = cookieFrom(await login("admin", "correct-password"), TWO_FACTOR_COOKIE);
    const temporary = await proxy(new NextRequest(`${origin}/admin`, {
      headers: { cookie: `${TWO_FACTOR_COOKIE}=${cookieState.challenge}` },
    }));
    expect(temporary.status).toBe(307);
    const verified = await verify(totpCode(secret));
    const session = cookieFrom(verified, SESSION_COOKIE);
    const final = await proxy(new NextRequest(`${origin}/admin`, {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    }));
    expect(final.status).toBe(200);
  });

  it("rate-limits repeated password and TOTP attempts", async () => {
    for (let index = 0; index < 5; index++)
      expect((await login("wrong", "wrong", "10.0.0.9")).status).toBe(401);
    expect((await login("wrong", "wrong", "10.0.0.9")).status).toBe(429);

    const original = cookieFrom(await login("admin", "correct-password", "10.0.0.8"), TWO_FACTOR_COOKIE);
    for (let index = 0; index < 5; index++) {
      cookieState.challenge = original;
      expect((await verify("000000", "10.0.0.8")).status).toBe(401);
    }
    cookieState.challenge = original;
    expect((await verify("000000", "10.0.0.8")).status).toBe(429);
  });
});

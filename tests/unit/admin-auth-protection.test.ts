import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { resetEnvForTests } from "@/lib/env";
import { config, proxy } from "@/proxy";

const url = (path: string) => `https://sync.example.com${path}`;

function request(path: string, token?: string) {
  return new NextRequest(url(path), {
    headers: token ? { cookie: `${SESSION_COOKIE}=${token}` } : undefined,
  });
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-characters";
  resetEnvForTests();
});

describe("admin authentication protection", () => {
  it("redirects unauthenticated /admin/products to login", async () => {
    const response = await proxy(request("/admin/products"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(url("/admin/login"));
  });

  it("allows authenticated /admin/products", async () => {
    const response = await proxy(
      request("/admin/products", await createSession("admin")),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("allows /admin/login without a session", async () => {
    const response = await proxy(request("/admin/login"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("redirects authenticated /admin/login to /admin", async () => {
    const response = await proxy(
      request("/admin/login", await createSession("admin")),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(url("/admin"));
  });

  it("returns 401 for a protected admin API without a session", async () => {
    const response = await proxy(request("/api/admin/products"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ success: false });
    expect(config.matcher).toContain("/api/admin/:path*");
  });
});

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), getEnv: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ query: mocks.query }));
vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));

import { log } from "@/lib/logger";

describe("authentication data leak prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnv.mockReturnValue({ LOG_LEVEL: "debug" });
    mocks.query.mockResolvedValue([]);
  });

  it("uses POST forms with fixed endpoints so credentials never enter URLs", () => {
    const source = readFileSync("components/admin/login-form.tsx", "utf8");
    expect(source).toContain('method="post"');
    expect(source).toContain('action="/api/auth/login"');
    expect(source).toContain('action="/api/auth/2fa"');
    expect(source).not.toMatch(/method=["']get["']/i);
    expect(source).not.toMatch(/\/api\/auth\/(?:login|2fa)\?[^"']/);
  });

  it("redacts credentials, TOTP, challenges and auth headers from all log sinks", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await log("info", "auth audit", {
      action: "auth_attempt",
      username: "admin-marker",
      password: "password-marker",
      code: "123456",
      totpSecret: "totp-marker",
      sessionToken: "session-marker",
      authChallenge: "challenge-marker",
      Authorization: "Bearer auth-marker",
      Cookie: "cookie-marker",
      requestBody: { password: "nested-password", verificationCode: "654321" },
    });
    const output = stdout.mock.calls.flat().join(" ");
    const persisted = JSON.stringify(mocks.query.mock.calls);
    for (const secret of [
      "admin-marker", "password-marker", "123456", "totp-marker",
      "session-marker", "challenge-marker", "auth-marker", "cookie-marker",
      "nested-password", "654321",
    ]) {
      expect(output).not.toContain(secret);
      expect(persisted).not.toContain(secret);
    }
    stdout.mockRestore();
  });
});


import { beforeEach, describe, expect, it } from "vitest";
import { resetEnvForTests } from "@/lib/env";
import { assertTrustedOrigin } from "@/lib/security/csrf";

beforeEach(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.PUBLIC_APP_URL = "https://sync.example.com";
  resetEnvForTests();
});

describe("trusted request origins", () => {
  it("accepts the internal and configured public application origins", () => {
    expect(() => assertTrustedOrigin(new Request("http://localhost:3000", {
      headers: { origin: "http://localhost:3000" },
    }))).not.toThrow();
    expect(() => assertTrustedOrigin(new Request("https://sync.example.com", {
      headers: { origin: "https://sync.example.com" },
    }))).not.toThrow();
  });

  it("rejects an unrelated origin", () => {
    expect(() => assertTrustedOrigin(new Request("https://sync.example.com", {
      headers: { origin: "https://evil.example.com" },
    }))).toThrow("Invalid request origin");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvForTests } from "@/lib/env";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));
vi.mock("@/lib/db/client", () => ({ query: mocks.query }));

import { GET } from "@/app/api/admin/[resource]/route";

beforeEach(() => {
  mocks.query.mockReset();
  process.env.SESSION_SECRET = "test-session-secret-that-is-at-least-32-characters";
  resetEnvForTests();
});

describe("admin API authorization", () => {
  it("returns 401 before querying protected data without a session", async () => {
    const response = await GET(new Request("https://sync.example.com/api/admin/products"), {
      params: Promise.resolve({ resource: "products" }),
    });
    expect(response.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

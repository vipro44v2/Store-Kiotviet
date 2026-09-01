import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvForTests } from "@/lib/env";

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), backfill: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/auth/middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/middleware")>();
  return { ...actual, requireAdmin: mocks.requireAdmin };
});
vi.mock("@/lib/sync/mapping-backfill", () => ({ runMappingBackfill: mocks.backfill }));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));
import { POST } from "@/app/api/admin/products/mappings/route";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_URL = "http://localhost:3000";
  resetEnvForTests();
  mocks.requireAdmin.mockResolvedValue(undefined);
  mocks.log.mockResolvedValue(undefined);
});

describe("create all mappings admin action", () => {
  it("applies exact backfill and returns UI counts", async () => {
    mocks.backfill.mockResolvedValue({
      dryRun: false, totalShopifySkus: 10, totalKiotVietCodes: 9,
      alreadyMapped: 3, newMappings: 4, missingShopify: 1,
      missingKiotViet: 2, duplicateAmbiguous: 1, errors: [],
    });
    const response = await POST(new Request("http://localhost:3000/api/admin/products/mappings", {
      method: "POST", headers: { origin: "http://localhost:3000" },
    }));
    await expect(response.json()).resolves.toMatchObject({
      created: 4, existing: 3, missing: 1, duplicate: 1,
    });
    expect(mocks.backfill).toHaveBeenCalledWith({ apply: true });
  });
});

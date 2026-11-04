import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ get: vi.fn(), env: "", branches: [{ id: 10 }] as Array<{ id: number }> }));
vi.mock("@/lib/kiotviet/client", () => ({ kiotVietClient: { get: m.get } }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ KIOTVIET_DEFAULT_SOLD_BY_ID: m.env }) }));
vi.mock("@/lib/kiotviet/branches", () => ({ getActiveKiotVietBranches: async () => m.branches }));
import { defaultSellerId, listKiotVietUsers, resolveInvoiceSeller, resolveNewOrderSeller } from "@/lib/kiotviet/users";
import { ConflictError } from "@/lib/errors";

const users = (data: Array<Record<string, unknown>>) => m.get.mockResolvedValue({ total: data.length, pageSize: 100, data });

beforeEach(() => {
  m.get.mockReset();
  m.env = "";
  m.branches = [{ id: 10 }];
});

describe("GET /users", () => {
  it("reads every page", async () => {
    m.get.mockResolvedValueOnce({ total: 150, pageSize: 100, data: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) })
      .mockResolvedValueOnce({ total: 150, pageSize: 100, data: Array.from({ length: 50 }, (_, i) => ({ id: i + 101 })) });
    expect(await listKiotVietUsers()).toHaveLength(150);
    expect(m.get.mock.calls[1][0]).toContain("currentItem=100");
  });

  it("refuses to verify a seller from an incomplete list", async () => {
    m.get.mockResolvedValueOnce({ total: 150, pageSize: 100, data: [{ id: 1 }] }).mockResolvedValueOnce({ total: 150, pageSize: 100, data: [] });
    await expect(resolveInvoiceSeller({ soldById: 1, branchId: 10 })).rejects.toThrow("incomplete");
  });
});

describe("KIOTVIET_DEFAULT_SOLD_BY_ID", () => {
  it.each([["", "not configured"], ["abc", "not a positive integer"], ["0", "not a positive integer"], ["-5", "not a positive integer"], ["1.5", "not a positive integer"]])(
    "%j → %s (reported, never thrown at startup)", (value, problem) => {
      m.env = value;
      expect(defaultSellerId()).toMatchObject({ id: null, problem: expect.stringContaining(problem) });
    });
  it("accepts a positive integer", () => {
    m.env = " 1000012735 ";
    expect(defaultSellerId()).toEqual({ id: 1000012735, problem: null });
  });
});

describe("new KiotViet order seller", () => {
  it("uses the verified ENV seller", async () => {
    m.env = "77";
    users([{ id: 77, givenName: "Kho" }]);
    await expect(resolveNewOrderSeller(10)).resolves.toEqual({ soldById: 77, source: "default" });
  });

  it.each([
    ["ENV missing", () => {}, "not configured"],
    ["ENV malformed", () => { m.env = "x77"; }, "not a positive integer"],
    ["seller deleted", () => { m.env = "77"; users([]); }, "does not exist or was deleted"],
    ["seller inactive", () => { m.env = "77"; users([{ id: 77, isActive: false }]); }, "is inactive"],
    ["seller in another branch", () => { m.env = "77"; users([{ id: 77, branchIds: [11] }]); }, "does not belong to the order's branch"],
    ["branch unprovable in a multi-branch store", () => { m.env = "77"; users([{ id: 77 }]); m.branches = [{ id: 10 }, { id: 11 }]; }, "cannot be verified for the order's branch"],
  ])("stops with seller_invalid when %s (no ID in the message)", async (_label, setup, message) => {
    setup();
    const error = await resolveNewOrderSeller(10).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toContain("seller_invalid");
    expect(error.message).toContain(message);
    expect(error.message).not.toContain("77");
  });

  it("accepts a seller whose branchIds include the order branch in a multi-branch store", async () => {
    m.env = "77";
    m.branches = [{ id: 10 }, { id: 11 }];
    users([{ id: 77, branchIds: [10, 11] }]);
    await expect(resolveNewOrderSeller(10)).resolves.toEqual({ soldById: 77, source: "default" });
  });

  it("propagates a failing verification API (nothing is sent)", async () => {
    m.env = "77";
    m.get.mockRejectedValue(new Error("KiotViet 503"));
    await expect(resolveNewOrderSeller(10)).rejects.toThrow("503");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getActiveBranches: vi.fn(),
  createCustomer: vi.fn(),
  updateCustomer: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ query: mocks.query }));
vi.mock("@/lib/kiotviet/branches", () => ({
  getActiveKiotVietBranches: mocks.getActiveBranches,
}));
vi.mock("@/lib/kiotviet/customers", () => ({
  createKiotVietCustomer: mocks.createCustomer,
  updateKiotVietCustomer: mocks.updateCustomer,
}));

import { syncShopifyCustomer } from "@/lib/sync/customer-sync";

const customer = {
  id: 123,
  first_name: "Fresh",
  last_name: "Customer",
  email: "fresh@example.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createCustomer.mockResolvedValue({ id: 500, code: "KH500" });
});

function mockNewCustomerQueries(settings: Record<string, unknown>) {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT kiotviet_customer_id")) return [];
    if (sql.includes("SELECT id FROM customer_mappings")) return [];
    if (sql.includes("SELECT value FROM system_settings"))
      return [{ value: settings }];
    if (sql.includes("INSERT INTO system_settings")) {
      settings.defaultBranchId = 42;
      return [{ default_branch_id: "42" }];
    }
    return [];
  });
}

describe("customer default branch resolution", () => {
  it("creates a customer on a fresh database with one active branch", async () => {
    const settings = {
      autoCreate: true,
      paidOnly: true,
      syncCustomers: true,
      syncCancellation: true,
      syncRefunds: true,
    };
    mockNewCustomerQueries(settings);
    mocks.getActiveBranches.mockResolvedValue([
      { id: 42, branchName: "Main", isActive: true },
    ]);

    await expect(syncShopifyCustomer(customer)).resolves.toEqual({
      created: true,
      kiotvietCustomerId: "500",
    });

    expect(mocks.createCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 42 }),
    );
    expect(settings).toEqual({
      autoCreate: true,
      paidOnly: true,
      syncCustomers: true,
      syncCancellation: true,
      syncRefunds: true,
      defaultBranchId: 42,
    });
  });

  it("uses an existing valid defaultBranchId for customer sync", async () => {
    const settings = { defaultBranchId: 42, futureSetting: "preserved" };
    mockNewCustomerQueries(settings);
    mocks.getActiveBranches.mockResolvedValue([
      { id: 42, branchName: "Main", isActive: true },
    ]);

    await syncShopifyCustomer(customer);

    expect(mocks.createCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 42 }),
    );
    expect(
      mocks.query.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO system_settings"),
      ),
    ).toBe(false);
    expect(settings).toEqual({
      defaultBranchId: 42,
      futureSetting: "preserved",
    });
  });
});

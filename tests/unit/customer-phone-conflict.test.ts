import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCustomer: vi.fn(),
  findByPhone: vi.fn(),
  mappings: [] as Array<{ shopify_customer_id: string; kiotviet_customer_id: string }>,
  log: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  query: async (sql: string, params: unknown[] = []) => {
    if (sql.includes("SELECT kiotviet_customer_id FROM customer_mappings WHERE shopify_customer_id"))
      return mocks.mappings.filter((row) => row.shopify_customer_id === params[0]);
    if (sql.includes("SELECT id FROM customer_mappings")) return [];
    if (sql.includes("WHERE kiotviet_customer_id=$1"))
      return mocks.mappings.filter((row) => row.kiotviet_customer_id === String(params[0]));
    if (sql.startsWith("INSERT INTO customer_mappings")) {
      if (!mocks.mappings.some((row) => row.shopify_customer_id === params[0]))
        mocks.mappings.push({ shopify_customer_id: String(params[0]), kiotviet_customer_id: String(params[1]) });
      return [];
    }
    return [];
  },
}));
vi.mock("@/lib/kiotviet/customers", () => ({
  createKiotVietCustomer: mocks.createCustomer,
  findKiotVietCustomersByPhone: mocks.findByPhone,
}));
vi.mock("@/lib/sync/default-branch", () => ({ resolveDefaultBranchId: async () => 1 }));
vi.mock("@/lib/logger", () => ({ log: mocks.log }));

import { isDuplicatePhoneError, phoneKey, syncShopifyCustomer } from "@/lib/sync/customer-sync";
import { ApiError, ConflictError, isManualReviewError } from "@/lib/errors";

const duplicatePhone = new ApiError("KiotViet API error (420): Customer phone number already exists", 420);
const shopifyCustomer = {
  id: 1070, first_name: "Nguyễn", last_name: "Văn An", email: "an@example.com", phone: "+84901234567",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mappings = [];
  mocks.createCustomer.mockRejectedValue(duplicatePhone);
});

describe("KiotViet duplicate phone (Shopify #1070)", () => {
  it("recognizes only the duplicate-phone rejection", () => {
    expect(isDuplicatePhoneError(duplicatePhone)).toBe(true);
    expect(isDuplicatePhoneError(new ApiError("KiotViet API error (420): Số điện thoại đã tồn tại", 420))).toBe(true);
    expect(isDuplicatePhoneError(new ApiError("KiotViet API error (420): Invalid branch", 420))).toBe(false);
    expect(isDuplicatePhoneError(new ApiError("KiotViet API error (400): phone already exists", 400))).toBe(false);
    expect(phoneKey("+84 901 234 567")).toBe("0901234567");
  });

  it("reuses the single KiotViet customer whose phone and email match", async () => {
    mocks.findByPhone.mockResolvedValue([{ id: 880, name: "Khác tên", contactNumber: "0901234567", email: "AN@example.com" }]);
    await expect(syncShopifyCustomer(shopifyCustomer)).resolves.toEqual({ created: false, reused: true, kiotvietCustomerId: "880" });
    expect(mocks.mappings).toEqual([{ shopify_customer_id: "1070", kiotviet_customer_id: "880" }]);
    expect(mocks.createCustomer).toHaveBeenCalledOnce();
    expect(mocks.log).toHaveBeenCalledWith("info", expect.any(String), expect.objectContaining({ verifiedBy: "phone_and_email" }));
  });

  it("reuses on phone and full name when KiotViet has no email (diacritics ignored)", async () => {
    mocks.findByPhone.mockResolvedValue([{ id: 880, name: "nguyen van an", contactNumber: "84901234567", email: null }]);
    await expect(syncShopifyCustomer(shopifyCustomer)).resolves.toMatchObject({ reused: true, kiotvietCustomerId: "880" });
  });

  it.each([
    ["the emails differ", [{ id: 880, name: "Nguyễn Văn An", contactNumber: "0901234567", email: "other@example.com" }], "customer_identity_mismatch"],
    ["the name differs and there is no email", [{ id: 880, name: "Trần Thị B", contactNumber: "0901234567", email: "" }], "customer_identity_unverified"],
    ["several KiotViet customers share the phone", [
      { id: 880, name: "Nguyễn Văn An", contactNumber: "0901234567", email: "an@example.com" },
      { id: 881, name: "Nguyễn Văn An", contactNumber: "+84901234567", email: "an@example.com" },
    ], "ambiguous_customer"],
    ["KiotViet returns no customer with that exact phone", [{ id: 880, name: "Nguyễn Văn An", contactNumber: "0901234568" }], "customer_not_found"],
  ])("goes to manual review without creating or merging when %s", async (_label, candidates, status) => {
    mocks.findByPhone.mockResolvedValue(candidates);
    const error = await syncShopifyCustomer(shopifyCustomer).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(isManualReviewError(error)).toBe(true);
    expect(error.details.mappingStatus).toBe(status);
    expect(mocks.mappings).toEqual([]);
    expect(mocks.createCustomer).toHaveBeenCalledOnce();
  });

  it("does not link a KiotViet customer that already belongs to another Shopify customer", async () => {
    mocks.mappings = [{ shopify_customer_id: "555", kiotviet_customer_id: "880" }];
    mocks.findByPhone.mockResolvedValue([{ id: 880, name: "Nguyễn Văn An", contactNumber: "0901234567", email: "an@example.com" }]);
    const error = await syncShopifyCustomer(shopifyCustomer).catch((e) => e);
    expect(error.details.mappingStatus).toBe("customer_linked_elsewhere");
    expect(mocks.mappings).toHaveLength(1);
  });

  it("does not log customer email, phone or name", async () => {
    mocks.findByPhone.mockResolvedValue([{ id: 880, name: "Nguyễn Văn An", contactNumber: "0901234567", email: "an@example.com" }]);
    await syncShopifyCustomer(shopifyCustomer);
    const logged = JSON.stringify(mocks.log.mock.calls);
    expect(logged).not.toMatch(/an@example|0901234567|Văn An/);
  });

  it("rethrows other KiotViet errors unchanged", async () => {
    const other = new ApiError("KiotViet API error (400): bad request", 400);
    mocks.createCustomer.mockRejectedValue(other);
    await expect(syncShopifyCustomer(shopifyCustomer)).rejects.toBe(other);
    expect(mocks.findByPhone).not.toHaveBeenCalled();
  });
});

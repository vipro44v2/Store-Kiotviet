import { beforeEach, expect, it, vi } from "vitest";
const get = vi.hoisted(() => vi.fn());
vi.mock("@/lib/kiotviet/client", () => ({ kiotVietClient: { get } }));
import { findKiotVietInvoicesForOrder } from "@/lib/kiotviet/invoices";
const run = () => findKiotVietInvoicesForOrder({ id: 7, code: "DH7", branchId: 10, customerId: 20 }, new Date());
beforeEach(() => { get.mockReset(); get.mockResolvedValueOnce({ total: 0, data: [] }).mockResolvedValueOnce({ total: 0, data: [] }); });
it("scopes scans and advances by actual returned count", async () => {
  get.mockResolvedValueOnce({ total: 2, pageSize: 100, data: [{ id: 1, orderCode: "other" }] });
  get.mockResolvedValueOnce({ total: 2, pageSize: 100, data: [{ id: 2, orderCode: "DH7" }] });
  expect(await run()).toMatchObject({ complete: true, invoices: [{ id: 2 }] });
  expect(get.mock.calls[1][0]).toContain("branchIds=10");
  expect(get.mock.calls[1][0]).toContain("customerIds=20");
  expect(get.mock.calls[3][0]).toContain("currentItem=1");
  expect(get.mock.calls[1][1]).toEqual({ timeoutMs: 8000, maxAttempts: 1 });
});
it.each([
  { data: [] }, { total: 2, data: [] }, { total: -1, data: [] },
  { total: 2, data: [{ id: 1 }, { id: 1 }] },
])("does not mistake malformed/incomplete pages for absence: %j", async page => {
  get.mockResolvedValue(page);
  expect((await run()).complete).toBe(false);
});
it("rejects repeated pages and changing totals", async () => {
  get.mockResolvedValue({ total: 2, data: [{ id: 1 }] });
  expect((await run()).complete).toBe(false);
  get.mockReset().mockResolvedValueOnce({ total: 0, data: [] })
    .mockResolvedValueOnce({ total: 0, data: [] }).mockResolvedValueOnce({ total: 2, data: [{ id: 1 }] }).mockResolvedValueOnce({ total: 3, data: [{ id: 2 }] });
  expect((await run()).complete).toBe(false);
});
it("retains known invoices but never proves absence after timeout", async () => {
  get.mockReset().mockResolvedValueOnce({ total: 1, data: [{ id: 5, orderCode: "DH7" }] }).mockRejectedValue(new Error("timeout"));
  expect(await run()).toMatchObject({ complete: false, invoices: [{ id: 5 }] });
});

it("does not call a scoped empty result proof of absence and avoids a large scan", async () => {
  get.mockResolvedValue({ total: 50000, data: [{ id: 1, orderCode: "other" }] });
  expect((await run()).complete).toBe(false);
  expect(get).toHaveBeenCalledTimes(3);
});

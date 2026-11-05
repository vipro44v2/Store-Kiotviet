import { describe, expect, it } from "vitest";
import { classifyOrderFilter, type OrderFilterSample } from "@/lib/kiotviet/invoice-order-filter";

const sample = (orderId: number, known: number[], data: Array<{ id: number; orderCode?: string | null }>): OrderFilterSample =>
  ({ orderId, orderCode: `DH${orderId}`, knownInvoiceIds: known, response: { total: data.length, data } });
const exact = [
  sample(1, [11], [{ id: 11, orderCode: "DH1" }]),
  sample(2, [21, 22], [{ id: 21, orderCode: "DH2" }, { id: 22, orderCode: "DH2" }]),
  sample(3, [31], [{ id: 31, orderCode: "DH3" }]),
  sample(4, [], []),
];
const empty = { total: 0, data: [] };

describe("GET /invoices?orderId= verification", () => {
  it("reports 'filters' only for exact results, an order without invoices and an empty control", () => {
    expect(classifyOrderFilter(exact, empty)).toMatchObject({ result: "filters" });
  });

  it("reports 'ignored' when the filter returns other orders' invoices", () => {
    const leaky = [...exact.slice(0, 3), sample(4, [], [{ id: 99, orderCode: "DH9" }])];
    expect(classifyOrderFilter(leaky, empty)).toMatchObject({ result: "ignored", notes: [expect.stringContaining("other orders")] });
  });

  it("reports 'ignored' when a nonexistent orderId still returns invoices", () => {
    expect(classifyOrderFilter(exact, { total: 13_215, data: [{ id: 1, orderCode: "DH1" }] })).toMatchObject({ result: "ignored" });
  });

  it("is inconclusive when a known invoice is missing or there are too few samples", () => {
    const missing = [sample(1, [11, 12], [{ id: 11, orderCode: "DH1" }]), ...exact.slice(1)];
    expect(classifyOrderFilter(missing, empty)).toMatchObject({ result: "inconclusive", notes: [expect.stringContaining("did not return known invoice")] });
    expect(classifyOrderFilter(exact.slice(0, 2), empty).result).toBe("inconclusive");
  });
});

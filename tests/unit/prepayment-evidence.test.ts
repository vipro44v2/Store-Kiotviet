import { describe, expect, it } from "vitest";
import { classifyPrepaymentObservation, prepaymentInheritanceStatus } from "@/lib/kiotviet/prepayment-evidence";

const evidence = {
  retailer: "sandbox-shop", testedAt: "2026-11-04T08:00:00.000Z",
  order: { id: 1, code: "DH-TEST", total: 100, prepaid: 100 },
  invoice: { id: 2, code: "HD-TEST", requestedTotalPayment: 0, total: 100, totalPayment: 100, paymentRows: [{ amount: 100 }] },
  orderAfter: { status: 3, totalPayment: 100 }, result: "carried" as const,
};

describe("sandbox prepayment observation", () => {
  it.each([
    [{ prepaid: 100, invoiceTotal: 100, invoiceTotalPayment: 100, paymentRows: [{ amount: 100 }] }, "carried"],
    [{ prepaid: 100, invoiceTotal: 100, invoiceTotalPayment: 0, paymentRows: [] }, "not_carried"],
    [{ prepaid: 100, invoiceTotal: 100, invoiceTotalPayment: 200, paymentRows: [{ amount: 100 }, { amount: 100 }] }, "inconclusive"],
    [{ prepaid: 100, invoiceTotal: 100, invoiceTotalPayment: 100, paymentRows: [{ amount: 100 }, { amount: 100 }] }, "inconclusive"],
    [{ prepaid: 0, invoiceTotal: 100, invoiceTotalPayment: 0, paymentRows: [] }, "inconclusive"],
  ])("%j → %s", (observed, result) => {
    expect(classifyPrepaymentObservation(observed)).toBe(result);
  });
});

describe("prepayment inheritance gate", () => {
  it("requires carried sandbox evidence AND accounting sign-off", () => {
    expect(prepaymentInheritanceStatus(evidence, true).verified).toBe(true);
    expect(prepaymentInheritanceStatus(evidence, false)).toMatchObject({ verified: false, reason: expect.stringContaining("accounting") });
    expect(prepaymentInheritanceStatus(undefined, true)).toMatchObject({ verified: false, reason: expect.stringContaining("no sandbox evidence") });
    expect(prepaymentInheritanceStatus({ ...evidence, result: "not_carried" }, true)).toMatchObject({ verified: false });
    expect(prepaymentInheritanceStatus({ ...evidence, testedAt: "yesterday" }, true).verified).toBe(false);
  });
});

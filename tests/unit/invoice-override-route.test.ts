import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ user: vi.fn(), origin: vi.fn(), preview: vi.fn(), submit: vi.fn() }));
vi.mock("@/lib/auth/middleware", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/middleware")>("@/lib/auth/middleware");
  return { ...actual, requireAdminUser: m.user };
});
vi.mock("@/lib/auth/session", () => ({ isAuthenticated: async () => false, getSessionUsername: async () => null }));
vi.mock("@/lib/security/csrf", () => ({ assertTrustedOrigin: m.origin }));
vi.mock("@/lib/recovery/invoice-override", () => ({ previewInvoiceOverride: m.preview, submitInvoiceOverride: m.submit }));

import { POST } from "@/app/api/admin/invoices/[orderId]/override/route";
import { AuthenticationError, ConflictError } from "@/lib/errors";
import { classifyInvoiceReasons } from "@/lib/sync/invoice-override-rules";

const call = (body: unknown, orderId = "7108106289336", headers: Record<string, string> = {}) =>
  POST(new Request(`https://sync.example.com/api/admin/invoices/${orderId}/override`, { method: "POST", body: JSON.stringify(body), headers }),
    { params: Promise.resolve({ orderId }) });
const submitBody = { step: "submit", previewToken: "t.s", approvedWarnings: ["total_mismatch"], confirm: true, reason: "Kế toán đã duyệt chênh lệch" };

beforeEach(() => {
  vi.clearAllMocks();
  m.user.mockResolvedValue("admin");
  m.origin.mockReturnValue(undefined);
  m.preview.mockResolvedValue({ preview: { submitAllowed: true }, previewToken: "t.s" });
  m.submit.mockResolvedValue({ applied: true, message: "Created invoice HD1: created" });
});

describe("POST /api/admin/invoices/[orderId]/override", () => {
  it("rejects unauthenticated requests before doing anything", async () => {
    m.user.mockRejectedValue(new AuthenticationError());
    const response = await call({ step: "preview" });
    expect(response.status).toBe(401);
    expect(m.preview).not.toHaveBeenCalled();
    expect(m.submit).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests (CSRF)", async () => {
    m.origin.mockImplementation(() => { throw new AuthenticationError("Invalid request origin"); });
    expect((await call(submitBody)).status).toBe(401);
    expect(m.submit).not.toHaveBeenCalled();
  });

  it("returns the server-side preview for an authenticated admin", async () => {
    const response = await call({ step: "preview" });
    expect(response.status).toBe(200);
    expect(m.preview).toHaveBeenCalledWith("7108106289336", "admin");
    expect(await response.json()).toMatchObject({ success: true, previewToken: "t.s" });
  });

  it("passes the authenticated admin (never a client-supplied one) and the client IP to the submit step", async () => {
    const response = await call({ ...submitBody }, "7108106289336", { "x-forwarded-for": "203.0.113.5, 10.0.0.1" });
    expect(response.status).toBe(200);
    expect(m.submit).toHaveBeenCalledWith(expect.objectContaining({ orderId: "7108106289336", admin: "admin", confirm: true, ipAddress: "203.0.113.5" }));
  });

  it.each([
    [{ ...submitBody, confirm: false }],
    [{ ...submitBody, reason: "short" }],
    [{ ...submitBody, admin: "attacker" }],
    [{ step: "apply" }],
  ])("rejects an invalid body %j", async (body) => {
    expect((await call(body)).status).toBe(400);
    expect(m.submit).not.toHaveBeenCalled();
  });

  it("rejects an invalid Shopify order ID", async () => {
    expect((await call({ step: "preview" }, "abc")).status).toBe(400);
  });

  it("maps blocked, changed or concurrent submissions to 409", async () => {
    m.submit.mockRejectedValue(new ConflictError("The order, invoice state or payload changed since the preview"));
    expect((await call(submitBody)).status).toBe(409);
    m.submit.mockResolvedValue({ applied: false, message: "Invoice state changed since the dry run (another run or worker); nothing changed" });
    expect((await call(submitBody)).status).toBe(409);
  });
});

describe("override rules", () => {
  it("allows only the listed financial warnings and denies everything else by default", () => {
    const { warnings, blockers } = classifyInvoiceReasons([
      "unsupported_shipping: x", "shipping_not_on_kiotviet_order: x", "shipping_mismatch: x", "total_mismatch: x",
      "amount_mismatch: x", "kiotviet_currency_not_configured: x", "overpaid: x", "unsupported_discount: x", "unsupported_tax: x",
      "invoice_lookup_incomplete: x", "duplicate_invoices: x", "invoice_in_flight: x", "invoice_outcome_unknown: x",
      "kiotviet_order_cancelled: x", "order_cancelled: x", "stale_payload: x", "sku_unmapped: x", "quantity_mismatch: x",
      "currency_mismatch: x", "refund_affects_products: x", "shipping_unverified: x", "some_future_code: x",
    ]);
    expect(warnings.map((item) => item.code)).toEqual([
      "unsupported_shipping", "shipping_not_on_kiotviet_order", "shipping_mismatch", "total_mismatch",
      "amount_mismatch", "kiotviet_currency_not_configured", "overpaid", "unsupported_discount", "unsupported_tax",
    ]);
    expect(blockers).toHaveLength(13);
  });
});

/**
 * SANDBOX ONLY. Observes how KiotViet carries an order's prepayment to an
 * invoice created from it (undocumented). Creates ONE test order (fully
 * prepaid) and ONE invoice for it (totalPayment 0) on a sandbox retailer, reads
 * both back, and writes evidence JSON. Never touches the database.
 *
 * Guards: KIOTVIET_SANDBOX=1 must be set, --retailer must equal the configured
 * KIOTVIET_RETAILER, and it must differ from KIOTVIET_PRODUCTION_RETAILER.
 * Dry run unless --execute.
 *
 *   KIOTVIET_SANDBOX=1 KIOTVIET_PRODUCTION_RETAILER=<prod> npx tsx --env-file=.env.sandbox \
 *     scripts/verify-kiotviet-prepayment-inheritance.ts --retailer <sandbox> --product-id <id> --branch-id <id> [--execute] [--out evidence.json]
 * Then import into production: scripts/record-kiotviet-prepayment-evidence.ts --file evidence.json
 */
import { writeFileSync } from "node:fs";
import { getEnv } from "../lib/env";
import { kiotVietClient } from "../lib/kiotviet/client";
import { createKiotVietInvoice, getKiotVietInvoiceDetail } from "../lib/kiotviet/invoices";
import { createKiotVietOrder, getKiotVietOrder } from "../lib/kiotviet/orders";
import { classifyPrepaymentObservation, type PrepaymentEvidence } from "../lib/kiotviet/prepayment-evidence";

const print = (line: string) => process.stdout.write(`${line}\n`);
const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

async function main() {
  const retailer = arg("--retailer"), productId = Number(arg("--product-id")), branchId = Number(arg("--branch-id"));
  const execute = process.argv.includes("--execute"), out = arg("--out");
  if (process.env.KIOTVIET_SANDBOX !== "1") throw new Error("Refusing to run: set KIOTVIET_SANDBOX=1 (sandbox retailer only)");
  if (!retailer || retailer !== getEnv().KIOTVIET_RETAILER)
    throw new Error("--retailer must equal KIOTVIET_RETAILER of the loaded env file");
  if (!process.env.KIOTVIET_PRODUCTION_RETAILER || process.env.KIOTVIET_PRODUCTION_RETAILER === retailer)
    throw new Error("Set KIOTVIET_PRODUCTION_RETAILER to the production retailer; it must differ from the sandbox retailer");
  if (!Number.isSafeInteger(productId) || productId <= 0 || !Number.isSafeInteger(branchId) || branchId <= 0)
    throw new Error("--product-id and --branch-id must be positive integers");

  const product = await kiotVietClient.get<{ id: number; code: string; name: string; basePrice?: number }>(`/products/${productId}`);
  const price = Number(product.basePrice);
  if (!(price > 0)) throw new Error(`Sandbox product ${productId} needs a positive basePrice`);
  const line = { productId: product.id, productCode: product.code, productName: product.name, quantity: 1, price };
  const orderInput = {
    branchId, description: `PREPAYMENT INHERITANCE TEST ${new Date().toISOString()} (sandbox; safe to delete)`,
    discount: 0, method: "Transfer", totalPayment: price, makeInvoice: false, orderDetails: [line],
  };
  print(`Sandbox retailer ${retailer}. Planned POST /orders: ${JSON.stringify(orderInput)}`);
  print(`Planned POST /invoices: {"branchId":${branchId},"orderId":<new order id>,"discount":0,"totalPayment":0,"method":"Transfer","invoiceDetails":[${JSON.stringify({ ...line, discount: 0 })}]}`);
  if (!execute) return print("DRY RUN: nothing created. Add --execute to run the sandbox test.");

  const order = await createKiotVietOrder(orderInput);
  const orderBefore = await getKiotVietOrder(order.id);
  const prepaid = Number(orderBefore.totalPayment ?? 0);
  print(`Created sandbox order ${order.code}; KiotViet records ${prepaid} prepaid`);
  const invoice = await createKiotVietInvoice({ branchId, orderId: order.id, discount: 0, totalPayment: 0, method: "Transfer", invoiceDetails: [{ ...line, discount: 0 }] });
  const detail = await getKiotVietInvoiceDetail(invoice.id) as Awaited<ReturnType<typeof getKiotVietInvoiceDetail>> & { payments?: Array<{ amount?: number }> };
  const orderAfter = await getKiotVietOrder(order.id);
  const paymentRows = (detail.payments ?? []).map((row) => ({ amount: Number(row.amount ?? 0) }));
  const evidence: PrepaymentEvidence = {
    retailer,
    testedAt: new Date().toISOString(),
    order: { id: order.id, code: order.code, total: price, prepaid },
    invoice: { id: invoice.id, code: invoice.code, requestedTotalPayment: 0, total: Number(detail.total ?? 0), totalPayment: Number(detail.totalPayment ?? 0), paymentRows },
    orderAfter: { status: orderAfter.status ?? null, totalPayment: orderAfter.totalPayment ?? null },
    result: classifyPrepaymentObservation({ prepaid, invoiceTotal: Number(detail.total ?? 0), invoiceTotalPayment: Number(detail.totalPayment ?? 0), paymentRows }),
  };
  print(JSON.stringify(evidence, null, 2));
  if (out) writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  print(`RESULT: ${evidence.result}. Clean up in the sandbox: DELETE /invoices/${invoice.id} (isVoidPayment true), then DELETE /orders/${order.id}?IsVoidPayment=true.`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

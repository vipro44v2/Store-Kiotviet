import { z } from "zod";
import { adminApiErrorResponse, requireAdminUser } from "@/lib/auth/middleware";
import { assertTrustedOrigin } from "@/lib/security/csrf";
import { ConflictError } from "@/lib/errors";
import { previewInvoiceOverride, submitInvoiceOverride } from "@/lib/recovery/invoice-override";

export const runtime = "nodejs";

const body = z.discriminatedUnion("step", [
  z.object({ step: z.literal("preview") }).strict(),
  z.object({
    step: z.literal("submit"),
    previewToken: z.string().min(1).max(4000),
    approvedWarnings: z.array(z.string().max(64)).max(20),
    confirm: z.literal(true),
    reason: z.string().trim().min(10).max(1000),
  }).strict(),
]);

/** Step 1 (preview, read-only) and step 2 (submit) of the admin invoice override. */
export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const admin = await requireAdminUser();
    assertTrustedOrigin(request);
    const { orderId } = await params;
    if (!/^[1-9]\d{0,19}$/.test(orderId))
      return Response.json({ success: false, error: "Invalid Shopify order ID" }, { status: 400 });
    const input = body.parse(await request.json());
    if (input.step === "preview") {
      const { preview, previewToken } = await previewInvoiceOverride(orderId, admin);
      return Response.json({ success: true, preview, previewToken });
    }
    const result = await submitInvoiceOverride({
      orderId, admin, previewToken: input.previewToken, approvedWarnings: input.approvedWarnings,
      confirm: input.confirm, reason: input.reason,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });
    return Response.json({ success: result.applied, result }, { status: result.applied ? 200 : 409 });
  } catch (error) {
    if (error instanceof ConflictError)
      return Response.json({ success: false, error: error.message }, { status: 409 });
    return adminApiErrorResponse(error, "Invoice override failed");
  }
}

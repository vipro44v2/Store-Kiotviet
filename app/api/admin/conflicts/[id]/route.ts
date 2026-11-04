import { z } from "zod";
import { adminApiErrorResponse, requireAdmin } from "@/lib/auth/middleware";
import { assertTrustedOrigin } from "@/lib/security/csrf";
import { query } from "@/lib/db/client";
import { SHOPIFY_DEDUCTION_CONFLICT } from "@/lib/sync/inventory-sync";
const schema = z.object({
  resolution: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(["resolved", "ignored"]),
});
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin();
    assertTrustedOrigin(request);
    const { id } = await params,
      input = schema.parse(await request.json());
    await query(
      "UPDATE sync_conflicts SET resolution_status=$2,resolution=$3,resolved_at=now() WHERE id=$1",
      [id, input.status, JSON.stringify(input.resolution)],
    );
    // Resolving a held Shopify-deduction conflict accepts the Shopify quantity seen
    // at detection as the new baseline, so the next KiotViet sync may write again.
    // "ignored" keeps the hold; it is flagged again on the next detection.
    if (input.status === "resolved")
      await query(
        `INSERT INTO inventory_snapshots(sku,branch_id,shopify_location_id,kiotviet_quantity,shopify_quantity,expected_shopify_quantity,difference,status)
        SELECT shopify_value->>'sku',(kiotviet_value->>'branchId')::bigint,shopify_value->>'locationId',
          (kiotviet_value->>'onHand')::numeric,(shopify_value->>'available')::numeric,(shopify_value->>'available')::numeric,0,'baseline'
        FROM sync_conflicts WHERE id=$1 AND entity_type='inventory' AND conflict_type=$2`,
        [id, SHOPIFY_DEDUCTION_CONFLICT],
      );
    return Response.json({ success: true });
  } catch (error) {
    return adminApiErrorResponse(error, "Action failed");
  }
}

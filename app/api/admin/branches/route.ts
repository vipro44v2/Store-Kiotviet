import { z } from "zod";
import { requireAdmin } from "@/lib/auth/middleware";
import { assertTrustedOrigin } from "@/lib/security/csrf";
import { getKiotVietBranches } from "@/lib/kiotviet/branches";
import { getShopifyLocations } from "@/lib/shopify/locations";
import { query } from "@/lib/db/client";
const schema = z.object({
  kiotVietBranchId: z.number().int().positive(),
  kiotVietBranchName: z.string().min(1),
  shopifyLocationId: z.string().min(1),
  shopifyLocationName: z.string().min(1),
  enabled: z.boolean().default(true),
  safetyStock: z.number().nonnegative().default(0),
});
export async function GET() {
  try {
    await requireAdmin();
    const [branches, locations, mappings] = await Promise.all([
      getKiotVietBranches(),
      getShopifyLocations(),
      query<Record<string, unknown>>(
        "SELECT * FROM branch_location_mappings ORDER BY kiotviet_branch_name",
      ),
    ]);
    return Response.json({ success: true, branches, locations, mappings });
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unavailable",
      },
      { status: 502 },
    );
  }
}
export async function PUT(request: Request) {
  try {
    await requireAdmin();
    assertTrustedOrigin(request);
    const input = schema.parse(await request.json());
    await query(
      `INSERT INTO branch_location_mappings(kiotviet_branch_id,kiotviet_branch_name,shopify_location_id,shopify_location_name,enabled,safety_stock) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(kiotviet_branch_id,shopify_location_id) DO UPDATE SET kiotviet_branch_name=EXCLUDED.kiotviet_branch_name,shopify_location_name=EXCLUDED.shopify_location_name,enabled=EXCLUDED.enabled,safety_stock=EXCLUDED.safety_stock,updated_at=now()`,
      [
        input.kiotVietBranchId,
        input.kiotVietBranchName,
        input.shopifyLocationId,
        input.shopifyLocationName,
        input.enabled,
        input.safetyStock,
      ],
    );
    return Response.json({ success: true });
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Invalid mapping",
      },
      { status: 400 },
    );
  }
}

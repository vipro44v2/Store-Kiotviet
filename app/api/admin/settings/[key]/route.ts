import { z } from "zod";
import { adminApiErrorResponse, requireAdmin } from "@/lib/auth/middleware";
import { assertTrustedOrigin } from "@/lib/security/csrf";
import { query } from "@/lib/db/client";
import { getAllKiotVietCategories } from "@/lib/kiotviet/products";

const allowed = new Set([
  "inventory", "products", "orders", "retention", "customers",
  "notifications", "synchronization", "draft_product_categories",
]);
const schema = z.record(z.string(), z.unknown());

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    await requireAdmin();
    assertTrustedOrigin(request);
    const { key } = await params;
    if (!allowed.has(key))
      return Response.json(
        { success: false, error: "Unknown setting" },
        { status: 404 },
      );
    let value = schema.parse(await request.json());
    if (key === "draft_product_categories") {
      const parsed = z.object({ categoryIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)) }).strict().parse(value);
      const categoryIds = [...new Set(parsed.categoryIds)].sort((a, b) => a - b);
      if (categoryIds.length) {
        const available = new Set((await getAllKiotVietCategories()).map((category) => category.id ?? category.categoryId));
        if (categoryIds.some((id) => !available.has(id)))
          return Response.json({ success: false, error: "Select valid KiotViet category IDs" }, { status: 400 });
      }
      value = { categoryIds };
    }
    await query(
      "INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
      [key, JSON.stringify(value)],
    );
    return Response.json({ success: true });
  } catch (error) {
    return adminApiErrorResponse(error, "Invalid settings");
  }
}

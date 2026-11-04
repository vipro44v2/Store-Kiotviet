import { z } from "zod";
import { adminApiErrorResponse, requireAdmin } from "@/lib/auth/middleware";
import { assertTrustedOrigin } from "@/lib/security/csrf";
import { query } from "@/lib/db/client";
import { getAllKiotVietCategories } from "@/lib/kiotviet/products";
import { SYNC_SETTINGS_KEY, synchronizationSettingsSchema } from "@/lib/settings/sync-settings";

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
    if (key === SYNC_SETTINGS_KEY) value = synchronizationSettingsSchema.parse(value);
    if (key === "orders")
      value = z.object({
        autoInvoice: z.boolean().optional(),
        invoiceCreationTrigger: z.enum(["shopify_fulfilled", "shopify_paid", "disabled"]).optional(),
        kiotVietCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
      }).passthrough().refine((orders) => (orders.invoiceCreationTrigger === "disabled" || (!orders.invoiceCreationTrigger && orders.autoInvoice !== true)) || Boolean(orders.kiotVietCurrency), {
        message: "orders.kiotVietCurrency is required when orders.autoInvoice is enabled",
      }).parse(value);
    if (key === "orders") {
      // Derive activation time in PostgreSQL, never trust a browser-supplied cutoff.
      delete value.invoiceTriggerEnabledAt;
      await query(
        `INSERT INTO system_settings(key,value,updated_at) VALUES('orders',$1::jsonb || jsonb_build_object('invoiceTriggerEnabledAt',now()),now())
        ON CONFLICT(key) DO UPDATE SET value=$1::jsonb || jsonb_build_object('invoiceTriggerEnabledAt',
          CASE WHEN system_settings.value->>'invoiceCreationTrigger' IS DISTINCT FROM $1::jsonb->>'invoiceCreationTrigger'
          THEN to_jsonb(now()) ELSE COALESCE(system_settings.value->'invoiceTriggerEnabledAt',to_jsonb(now())) END),updated_at=now()`,
        [JSON.stringify(value)],
      );
      return Response.json({ success: true });
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

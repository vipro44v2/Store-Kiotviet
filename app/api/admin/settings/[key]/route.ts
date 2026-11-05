import { z } from "zod";
import { adminApiErrorResponse, requireAdmin, requireAdminUser } from "@/lib/auth/middleware";
import { assertTrustedOrigin } from "@/lib/security/csrf";
import { query } from "@/lib/db/client";
import { getAllKiotVietCategories } from "@/lib/kiotviet/products";
import { listKiotVietSurcharges } from "@/lib/kiotviet/surcharges";
import { ordersSettingsSchema } from "@/lib/settings/order-settings";
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
    if (key === "orders") {
      const orders = ordersSettingsSchema.parse(value);
      if (orders.shippingSurcharge) {
        // Must be a real KiotViet "thu khác"; never an invented id/code.
        const { id, code } = orders.shippingSurcharge;
        const exists = (await listKiotVietSurcharges()).some((surcharge) => surcharge.id === id && surcharge.surchargeCode === code);
        if (!exists)
          return Response.json({ success: false, error: `KiotViet surcharge ${id} (${code}) was not found in GET /surchages` }, { status: 400 });
      }
      value = orders;
    }
    if (key === "orders") {
      // Derive activation time in PostgreSQL, never trust a browser-supplied cutoff.
      delete value.invoiceTriggerEnabledAt;
      // Who accepted the unverified-prepayment risk, and when, is recorded by the server only.
      delete value.unverifiedPrepaymentAcceptedAt;
      delete value.unverifiedPrepaymentAcceptedBy;
      const admin = await requireAdminUser();
      const [current] = await query<{ value: Record<string, unknown> }>("SELECT value FROM system_settings WHERE key='orders'");
      const wasAllowed = current?.value?.allowUnverifiedPrepaymentInheritance === true;
      if (value.allowUnverifiedPrepaymentInheritance === true) {
        value.unverifiedPrepaymentAcceptedAt = wasAllowed ? current.value.unverifiedPrepaymentAcceptedAt : new Date().toISOString();
        value.unverifiedPrepaymentAcceptedBy = wasAllowed ? current.value.unverifiedPrepaymentAcceptedBy : admin;
      } else delete value.acknowledgeUnverifiedPrepaymentRisk; // re-enabling asks for confirmation again
      if (wasAllowed !== (value.allowUnverifiedPrepaymentInheritance === true))
        await query(
          "INSERT INTO audit_logs(actor_type,actor,action,entity_type,entity_id,before_data,after_data) VALUES('admin',$1,$2,'system_settings','orders',$3,$4)",
          [admin, value.allowUnverifiedPrepaymentInheritance === true ? "unverified_prepayment_inheritance_enabled" : "unverified_prepayment_inheritance_disabled",
            JSON.stringify({ allowUnverifiedPrepaymentInheritance: wasAllowed }),
            JSON.stringify({ allowUnverifiedPrepaymentInheritance: value.allowUnverifiedPrepaymentInheritance, acknowledged: value.acknowledgeUnverifiedPrepaymentRisk === true })],
        );
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

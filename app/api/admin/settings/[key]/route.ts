import { z } from "zod";
import { adminApiErrorResponse, requireAdmin } from "@/lib/auth/middleware";
import { assertTrustedOrigin } from "@/lib/security/csrf";
import { query } from "@/lib/db/client";

const allowed = new Set([
  "inventory", "products", "orders", "retention", "customers",
  "notifications", "synchronization",
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
    const value = schema.parse(await request.json());
    await query(
      "INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
      [key, JSON.stringify(value)],
    );
    return Response.json({ success: true });
  } catch (error) {
    return adminApiErrorResponse(error, "Invalid settings");
  }
}

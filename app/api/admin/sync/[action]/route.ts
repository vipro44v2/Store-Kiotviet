import { requireAdmin } from "@/lib/auth/middleware";
import { assertTrustedOrigin } from "@/lib/security/csrf";
import { enqueueJob } from "@/lib/queue/queues";
import type { JobType } from "@/lib/queue/jobs";
const actions: Record<string, JobType> = {
  products: "full_product_sync",
  inventory: "full_inventory_sync",
  orders: "full_order_reconciliation",
  mappings: "product_mapping_scan",
  reconcile: "inventory_reconciliation",
  returns: "kiotviet_return_reconciliation",
  product: "kiotviet_product_to_shopify",
  return: "kiotviet_return_to_shopify",
  tracking: "kiotviet_invoice_to_shopify",
};
export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  try {
    await requireAdmin();
    assertTrustedOrigin(request);
    const { action } = await context.params;
    const type = actions[action];
    if (!type)
      return Response.json(
        { success: false, error: "Unknown sync action" },
        { status: 404 },
      );
    const body=await request.json().catch(()=>({})) as Record<string,unknown>;
    const idFields:Record<string,string>={product:"productId",return:"returnId",tracking:"invoiceId"},idField=idFields[action];
    const id=idField?Number(body[idField]):undefined;
    if(idField&&(!Number.isSafeInteger(id)||Number(id)<=0))return Response.json({success:false,error:`${idField} must be a positive integer`},{status:400});
    const payload:Record<string,unknown>={manual:true};if(idField)payload[idField]=id;
    const job = await enqueueJob(
      ["reconcile","returns"].includes(action) ? "reconciliation" : "sync",
      type,
      payload,
      "normal",
    );
    return Response.json({ success: true, jobId: job.id }, { status: 202 });
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Request failed",
      },
      { status: 400 },
    );
  }
}

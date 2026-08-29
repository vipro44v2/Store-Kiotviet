import { receiveKiotVietWebhook } from "@/lib/kiotviet/webhooks";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const result = await receiveKiotVietWebhook(request);
    return Response.json(result.body, { status: result.status });
  } catch {
    return Response.json(
      { success: false, error: "Webhook service unavailable" },
      { status: 503 },
    );
  }
}

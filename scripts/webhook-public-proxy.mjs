import http from "node:http";
import { appendFile } from "node:fs/promises";

const port = 8787;
const kiotVietPath = "/api/webhooks/kiotviet";
const shopifyOrderPath = /^\/api\/shopify\/webhooks\/orders_(create|updated|cancelled)$/;
const diagnosticsPath = ".next/kiotviet-webhook-diagnostics.log";

async function diagnose(entry) {
  await appendFile(diagnosticsPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`).catch(() => undefined);
}

const server = http.createServer(async (request, response) => {
  const path = request.url?.split("?", 1)[0] ?? "";
  if (request.method !== "POST" || (path !== kiotVietPath && !shopifyOrderPath.test(path))) {
    await diagnose({ method: request.method, path: request.url, result: "rejected_route" });
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: false, error: "Not found" }));
    return;
  }

  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const upstream = await fetch(`http://127.0.0.1:3000${path}`, {
      method: "POST",
      headers: {
        "content-type": request.headers["content-type"] ?? "application/json",
        "x-hub-signature": request.headers["x-hub-signature"] ?? "",
        "x-shopify-hmac-sha256": request.headers["x-shopify-hmac-sha256"] ?? "",
        "x-shopify-webhook-id": request.headers["x-shopify-webhook-id"] ?? "",
        "x-shopify-topic": request.headers["x-shopify-topic"] ?? "",
        "x-shopify-shop-domain": request.headers["x-shopify-shop-domain"] ?? "",
        "x-shopify-api-version": request.headers["x-shopify-api-version"] ?? "",
      },
      body: Buffer.concat(chunks),
    });
    const signature = String(request.headers["x-hub-signature"] ?? "");
    await diagnose({ method: request.method, path, provider: path === kiotVietPath ? "kiotviet" : "shopify", signatureLength: signature.length || String(request.headers["x-shopify-hmac-sha256"] ?? "").length, signaturePrefix: signature.includes("=") ? signature.split("=", 1)[0] : "none", upstreamStatus: upstream.status });
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: false, error: "Webhook upstream unavailable" }));
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Webhook-only proxy listening on http://127.0.0.1:${port}\n`);
});

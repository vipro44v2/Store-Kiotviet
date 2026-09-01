import { loadEnvConfig } from "@next/env";
import { getEnv, getPublicAppUrl } from "../lib/env";
import { validateStoreConfig } from "../lib/store-config";
import { shopifyGraphql } from "../lib/shopify/graphql";
import { getShopifyLocations } from "../lib/shopify/locations";
import { getKiotVietBranches } from "../lib/kiotviet/branches";
import { kiotVietClient } from "../lib/kiotviet/client";
import { SHOPIFY_REGISTRATION_TOPICS } from "../lib/shopify/registration-topics";
import { inventoryRepository } from "../repositories/inventory";
import { runMappingBackfill } from "../lib/sync/mapping-backfill";
import { closeDatabase } from "../lib/db/client";
import { closeRedis } from "../lib/redis/client";

loadEnvConfig(process.cwd());

const KIOTVIET_WEBHOOK_TYPES = [
  "stock.update", "product.update", "product.delete", "order.update",
  "invoice.update", "category.update", "pricebookdetail.update",
] as const;

interface KiotVietWebhook { id: number; type: string; url: string; isActive: boolean }

async function shopifyWebhooks(apply: boolean) {
  const current = await shopifyGraphql<{ webhookSubscriptions: { nodes: Array<{ id: string; topic: string; endpoint?: { callbackUrl?: string } }> } }>(
    `query SetupWebhooks{webhookSubscriptions(first:100){nodes{id topic endpoint{... on WebhookHttpEndpoint{callbackUrl}}}}}`,
  );
  const results: Array<Record<string, unknown>> = [];
  for (const [topic, apiTopic] of Object.entries(SHOPIFY_REGISTRATION_TOPICS)) {
    const uri = `${getPublicAppUrl()}/api/shopify/webhooks/${topic.replace("/", "_")}`;
    const found = current.webhookSubscriptions.nodes.find((item) => item.topic === apiTopic);
    const verified = found?.endpoint?.callbackUrl === uri;
    if (!verified && apply) {
      const operation = found ? "webhookSubscriptionUpdate" : "webhookSubscriptionCreate";
      const mutation = found
        ? `mutation SetupUpdate($id:ID!,$subscription:WebhookSubscriptionInput!){webhookSubscriptionUpdate(id:$id,webhookSubscription:$subscription){userErrors{message}}}`
        : `mutation SetupCreate($topic:WebhookSubscriptionTopic!,$subscription:WebhookSubscriptionInput!){webhookSubscriptionCreate(topic:$topic,webhookSubscription:$subscription){userErrors{message}}}`;
      const variables = found ? { id: found.id, subscription: { uri, format: "JSON" } } : { topic: apiTopic, subscription: { uri, format: "JSON" } };
      const response = await shopifyGraphql<Record<string, { userErrors: Array<{ message: string }> }>>(mutation, variables);
      const errors = response[operation].userErrors.map((item) => item.message);
      results.push({ topic, uri, status: errors.length ? "error" : found ? "updated" : "registered", errors });
    } else results.push({ topic, uri, status: verified ? "verified" : "missing_or_wrong_url" });
  }
  return results;
}

async function kiotVietWebhooks(apply: boolean) {
  const response = await kiotVietClient.get<{ data?: KiotVietWebhook[] }>("/webhooks?pageSize=100");
  const current = response.data ?? [];
  const url = `${getPublicAppUrl()}/api/webhooks/kiotviet`;
  const results: Array<Record<string, unknown>> = [];
  for (const type of KIOTVIET_WEBHOOK_TYPES) {
    const found = current.find((item) => item.type === type && item.url === url && item.isActive);
    if (!found && apply) {
      await kiotVietClient.post("/webhooks", { Webhook: { Type: type, Url: url, IsActive: true, Description: "Shopify synchronization", Secret: getEnv().KIOTVIET_WEBHOOK_SECRET } });
      results.push({ type, url, status: "registered" });
    } else results.push({ type, url, status: found ? "verified" : "missing" });
  }
  return results;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const allowed = new Set(["--apply-webhooks", "--mapping-dry-run"]);
  const unknown = [...args].filter((arg) => !allowed.has(arg));
  if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  const env = getEnv();
  const configurationErrors = validateStoreConfig(env);
  if (configurationErrors.length) {
    process.stdout.write(`${JSON.stringify({ configuration: "invalid", errors: configurationErrors }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const apply = args.has("--apply-webhooks");
  const [shop, locations, branches, branchMappings, shopifyHooks, kiotVietHooks] = await Promise.all([
    shopifyGraphql<{ shop: { id: string; name: string; myshopifyDomain: string } }>(`query StoreIdentity{shop{id name myshopifyDomain}}`),
    getShopifyLocations(), getKiotVietBranches(), inventoryRepository.branchMappings(),
    shopifyWebhooks(apply), kiotVietWebhooks(apply),
  ]);
  const mappedBranches = new Set(branchMappings.filter((item) => item.enabled !== false).map((item) => String(item.kiotviet_branch_id)));
  const mappedLocations = new Set(branchMappings.filter((item) => item.enabled !== false).map((item) => String(item.shopify_location_id)));
  const report: Record<string, unknown> = {
    configuration: "valid", destructiveChanges: false, webhookMode: apply ? "apply" : "verify_only",
    shopify: { identity: shop.shop, locations },
    kiotViet: { identity: { retailer: env.KIOTVIET_RETAILER }, branches },
    webhooks: { shopify: shopifyHooks, kiotViet: kiotVietHooks },
    branchLocationMappings: {
      configured: branchMappings.length,
      missingBranches: branches.filter((item) => item.isActive !== false && !mappedBranches.has(String(item.id))),
      missingLocations: locations.filter((item) => item.isActive && !mappedLocations.has(String(item.id))),
    },
  };
  if (args.has("--mapping-dry-run")) report.mappingBackfill = await runMappingBackfill();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}).finally(async () => { await closeRedis(); await closeDatabase(); });

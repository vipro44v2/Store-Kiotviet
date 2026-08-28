import { getPublicAppUrl } from "../lib/env";
import { closeRedis } from "../lib/redis/client";
import { shopifyGraphql } from "../lib/shopify/graphql";

const topics = [
  ["ORDERS_CREATE", "orders_create"],
  ["ORDERS_UPDATED", "orders_updated"],
  ["ORDERS_CANCELLED", "orders_cancelled"],
] as const;

interface SubscriptionNode {
  id: string;
  topic: string;
  endpoint?: { callbackUrl?: string };
}

async function main() {
  const existing = await shopifyGraphql<{ webhookSubscriptions: { nodes: SubscriptionNode[] } }>(
    `query OrderWebhooks { webhookSubscriptions(first: 250) { nodes { id topic endpoint { ... on WebhookHttpEndpoint { callbackUrl } } } } }`,
  );

  for (const [topic, routeTopic] of topics) {
    const uri = `${getPublicAppUrl()}/api/shopify/webhooks/${routeTopic}`;
    const found = existing.webhookSubscriptions.nodes.find((node) => node.topic === topic && node.endpoint?.callbackUrl === uri);
    if (found) {
      process.stdout.write(`${routeTopic}: already registered (${found.id})\n`);
      continue;
    }
    const data = await shopifyGraphql<{ webhookSubscriptionCreate: { webhookSubscription?: { id: string }; userErrors: Array<{ message: string }> } }>(
      `mutation RegisterOrderWebhook($topic: WebhookSubscriptionTopic!, $subscription: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) { webhookSubscription { id } userErrors { message } } }`,
      { topic, subscription: { uri, format: "JSON" } },
    );
    const result = data.webhookSubscriptionCreate;
    if (result.userErrors.length || !result.webhookSubscription) throw new Error(`${routeTopic}: ${result.userErrors.map((error) => error.message).join("; ") || "registration failed"}`);
    process.stdout.write(`${routeTopic}: registered (${result.webhookSubscription.id})\n`);
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeRedis());

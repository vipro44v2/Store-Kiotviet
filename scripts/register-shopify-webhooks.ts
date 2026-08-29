import { shopifyGraphql } from "../lib/shopify/graphql";
import { assertProductionEnv, getEnv, getPublicAppUrl } from "../lib/env";

if (getEnv().NODE_ENV === "production") assertProductionEnv();

const topics = {
  "orders/create": "ORDERS_CREATE",
  "orders/updated": "ORDERS_UPDATED",
  "orders/cancelled": "ORDERS_CANCELLED",
  "customers/create": "CUSTOMERS_CREATE",
  "customers/update": "CUSTOMERS_UPDATE",
} as const;

async function main() {
const current = await shopifyGraphql<{
  webhookSubscriptions: { nodes: Array<{ id: string; topic: string }> };
}>(`query ExistingWebhooks { webhookSubscriptions(first:100) { nodes { id topic } } }`);

for (const [topic, enumTopic] of Object.entries(topics)) {
  const uri = `${getPublicAppUrl()}/api/shopify/webhooks/${topic.replace("/", "_")}`;
  const existing = current.webhookSubscriptions.nodes.find((item) => item.topic === enumTopic);

  if (existing) {
    const data = await shopifyGraphql<{
      webhookSubscriptionUpdate: { webhookSubscription?: { id: string }; userErrors: Array<{ message: string }> };
    }>(
      `mutation UpdateWebhook($id:ID!,$subscription:WebhookSubscriptionInput!){webhookSubscriptionUpdate(id:$id,webhookSubscription:$subscription){webhookSubscription{id} userErrors{message}}}`,
      { id: existing.id, subscription: { uri, format: "JSON" } },
    );
    const errors = data.webhookSubscriptionUpdate.userErrors;
    if (errors.length) process.stderr.write(`${topic}: ${errors.map((error) => error.message).join("; ")}\n`);
    else process.stdout.write(`${topic}: updated\n`);
    continue;
  }

  const data = await shopifyGraphql<{
    webhookSubscriptionCreate: { webhookSubscription?: { id: string }; userErrors: Array<{ message: string }> };
  }>(
    `mutation Register($topic:WebhookSubscriptionTopic!,$subscription:WebhookSubscriptionInput!){webhookSubscriptionCreate(topic:$topic,webhookSubscription:$subscription){webhookSubscription{id} userErrors{message}}}`,
    { topic: enumTopic, subscription: { uri, format: "JSON" } },
  );
  const errors = data.webhookSubscriptionCreate.userErrors;
  if (errors.length) process.stderr.write(`${topic}: ${errors.map((error) => error.message).join("; ")}\n`);
  else process.stdout.write(`${topic}: registered\n`);
}
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

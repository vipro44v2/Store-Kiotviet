import { shopifyGraphql } from "../lib/shopify/graphql";

async function main() {
  const data = await shopifyGraphql<{
    webhookSubscriptions: {
      nodes: Array<{ id: string; topic: string; endpoint: { __typename: string; callbackUrl?: string } }>;
    };
  }>(`query WebhookCheck { webhookSubscriptions(first:100) { nodes { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }`);

  console.log(JSON.stringify(data.webhookSubscriptions.nodes, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

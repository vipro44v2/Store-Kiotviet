import { shopifyGraphql } from "../lib/shopify/graphql";

async function main() {
  const data = await shopifyGraphql<{
    productVariants: { nodes: Array<{ sku: string; inventoryItem: { measurement: { weight: { value: number; unit: string } | null } } }> };
  }>(
    `query ProductWeight($query:String!){productVariants(first:10,query:$query){nodes{sku inventoryItem{measurement{weight{value unit}}}}}}`,
    { query: "sku:SP000001" },
  );
  console.log(JSON.stringify(data.productVariants.nodes, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

import { shopifyGraphql } from "../lib/shopify/graphql";

async function main() {
  const data = await shopifyGraphql<{
    productVariants: { nodes: Array<{ product: { id: string; title: string; options: Array<{ name: string; values: string[] }>; variants: { nodes: Array<{ id: string; sku: string; selectedOptions: Array<{ name: string; value: string }> }> } } }> };
  }>(`query VariantCheck($query:String!){productVariants(first:1,query:$query){nodes{product{id title options{name values} variants(first:100){nodes{id sku selectedOptions{name value}}}}}}}`, { query: "sku:SP000001" });
  console.log(JSON.stringify(data.productVariants.nodes[0]?.product ?? null, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

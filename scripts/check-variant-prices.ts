import { getKiotVietProduct, getKiotVietVariantFamily } from "../lib/kiotviet/products";
import { query } from "../lib/db/client";
import { shopifyGraphql } from "../lib/shopify/graphql";

async function main() {
  const productId = Number(process.argv[2]);
  if (!Number.isSafeInteger(productId) || productId <= 0)
    throw new Error("Usage: tsx scripts/check-variant-prices.ts <kiotviet-product-id>");
  const trigger = await getKiotVietProduct(productId);
  const family = await getKiotVietVariantFamily(trigger);
  const mappings = await query<{ kiotviet_product_id: string; sku: string; shopify_product_id: string; shopify_variant_id: string; last_sync_hash: string }>(
    "SELECT kiotviet_product_id,sku,shopify_product_id,shopify_variant_id,last_sync_hash FROM product_mappings WHERE kiotviet_product_id=ANY($1::bigint[])",
    [family.map((product) => product.id)],
  );
  const shopifyProductId = mappings.find((mapping) => mapping.shopify_product_id)?.shopify_product_id;
  const shopify = shopifyProductId ? await shopifyGraphql<{ product: { variants: { nodes: Array<{ id: string; sku: string; price: string }> } } | null }>(
    "query VariantPrices($id:ID!){product(id:$id){variants(first:250){nodes{id sku price}}}}",
    { id: shopifyProductId },
  ) : { product: null };
  console.log(JSON.stringify({ trigger, family: family.map((product) => ({ id: product.id, code: product.code, basePrice: product.basePrice, masterProductId: product.masterProductId, attributes: product.attributes })), mappings, shopify: shopify.product?.variants.nodes ?? [] }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });

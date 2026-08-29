import { getKiotVietProduct } from "../lib/kiotviet/products";
import { query } from "../lib/db/client";
import { shopifyGraphql } from "../lib/shopify/graphql";

async function main() {
  const productId = Number(process.argv[2] ?? 43043467);
  const kiotViet = await getKiotVietProduct(productId);
  const mappings = await query<{ shopify_variant_id: string; sku: string }>(
    "SELECT shopify_variant_id,sku FROM product_mappings WHERE kiotviet_product_id=$1",
    [String(productId)],
  );
  const variantId = mappings[0]?.shopify_variant_id;
  const shopify = variantId ? await shopifyGraphql<{ productVariant: { id: string; sku: string; price: string } | null }>(
    "query ProductPrice($id:ID!){productVariant(id:$id){id sku price}}",
    { id: variantId },
  ) : { productVariant: null };
  console.log(JSON.stringify({ kiotViet: { id: kiotViet.id, code: kiotViet.code, basePrice: kiotViet.basePrice }, mapping: mappings[0] ?? null, shopify: shopify.productVariant }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });

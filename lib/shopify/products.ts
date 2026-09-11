import { syncShopifyProductMedia } from "./product-media";
import { resolveProductStatus, type ProductStatus } from "@/lib/sync/product-status";
import { syncHash } from "@/lib/sync/hashes";
import { shopifyGraphql } from "./graphql";
import type { ShopifyVariant } from "@/types/shopify";
import type { KiotVietProduct } from "@/lib/kiotviet/types";

export function getShopifyVariants(after?: string) {
  return shopifyGraphql<{
    productVariants: {
      nodes: ShopifyVariant[];
      pageInfo: { hasNextPage: boolean; endCursor?: string };
    };
  }>(
    `query Variants($after:String){productVariants(first:100,after:$after){nodes{id sku barcode product{id title} inventoryItem{id tracked}} pageInfo{hasNextPage endCursor}}}`,
    { after: after ?? null },
  );
}
export async function findShopifyVariantsBySku(sku: string) {
  const data = await shopifyGraphql<{
    productVariants: { nodes: ShopifyVariant[] };
  }>(
    `query BySku($query:String!){productVariants(first:10,query:$query){nodes{id sku barcode product{id title} inventoryItem{id tracked}}}}`,
    { query: `sku:${sku}` },
  );
  return data.productVariants.nodes;
}

export async function getShopifyVariant(
  id: string,
): Promise<ShopifyVariant | undefined> {
  const data = await shopifyGraphql<{ productVariant: ShopifyVariant | null }>(
    `query ProductVariant($id:ID!){productVariant(id:$id){id sku barcode product{id title} inventoryItem{id tracked}}}`,
    { id },
  );
  return data.productVariant ?? undefined;
}

export async function shopifyProductExists(id: string): Promise<boolean> {
  const data = await shopifyGraphql<{ product: { id: string } | null }>(
    `query ProductExists($id:ID!){product(id:$id){id}}`,
    { id },
  );
  return Boolean(data.product);
}

type ManagedVariant = ShopifyVariant & { price?: string };
async function cleanupUncheckpointedProduct(productId: string, error: unknown): Promise<never> {
  try {
    const cleanup = await shopifyGraphql<{
      productDelete: { deletedProductId: string | null; userErrors: Array<{ message: string }> };
    }>(
      `mutation Cleanup($input:ProductDeleteInput!){productDelete(input:$input){deletedProductId userErrors{message}}}`,
      { input: { id: productId } },
    );
    if (cleanup.productDelete.userErrors.length || cleanup.productDelete.deletedProductId !== productId)
      throw new Error(cleanup.productDelete.userErrors.map((item) => item.message).join("; ") || "Shopify did not delete the uncheckpointed product");
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], `Shopify product ${productId} could not be checkpointed or cleaned up`);
  }
  throw error;
}
function productInput(product: KiotVietProduct, status: ProductStatus) {
  return {
    title: product.name,
    descriptionHtml: product.description ?? "",
    productType: product.categoryName ?? "",
    vendor: "KiotViet",
    status,
  };
}
export function inventoryItemInput(product: KiotVietProduct) {
  const weight = Number(product.weight);
  return {
    sku: product.code,
    tracked: true,
    ...(Number.isFinite(weight) && weight >= 0
      ? { measurement: { weight: { value: weight, unit: "GRAMS" as const } } }
      : {}),
  };
}
export async function createShopifyProduct(
  product: KiotVietProduct,
  checkpoint: (variant: ManagedVariant) => Promise<void>,
  status?: ProductStatus,
): Promise<ManagedVariant> {
  status ??= await resolveProductStatus([product]);
  const created = await shopifyGraphql<{
    productCreate: {
      product?: { id: string; variants: { nodes: ManagedVariant[] } };
      userErrors: Array<{ message: string }>;
    };
  }>(
    `mutation CreateProduct($product:ProductCreateInput!,$media:[CreateMediaInput!]){productCreate(product:$product,media:$media){product{id variants(first:1){nodes{id sku barcode product{id title} inventoryItem{id tracked}}}} userErrors{message}}}`,
    { product: productInput(product, status), media: [] },
  );
  if (created.productCreate.userErrors.length || !created.productCreate.product)
    throw new Error(
      created.productCreate.userErrors.map((e) => e.message).join("; ") ||
        "Shopify did not create the product",
    );
  const shopifyProduct = created.productCreate.product;
  const variant = shopifyProduct.variants.nodes[0];
  try {
    if (!variant?.id || !variant.inventoryItem?.id)
      throw new Error("Shopify product has no usable default variant");
    // Persist identity before any update can fail. This is not a successful
    // sync/hash: the default variant may still have an empty SKU.
    await checkpoint(variant);
  } catch (error) {
    // Without a usable durable identity this blank-SKU product cannot be
    // safely rediscovered. Never roll back after the checkpoint succeeds.
    return cleanupUncheckpointedProduct(shopifyProduct.id, error);
  }
  const saved = await updateShopifyProduct(product, variant, false, undefined, status);
  await syncShopifyProductMedia(shopifyProduct.id, product);
  return saved;
}

export async function updateShopifyProduct(
  product: KiotVietProduct,
  variant: ShopifyVariant,
  syncMedia = true,
  checkpoint?: (variant: ManagedVariant) => Promise<void>,
  status?: ProductStatus,
): Promise<ManagedVariant> {
  status ??= await resolveProductStatus([product]);
  const updated = await shopifyGraphql<{
    productUpdate: {
      product?: { id: string };
      userErrors: Array<{ message: string }>;
    };
  }>(
    `mutation UpdateProduct($product:ProductUpdateInput!,$media:[CreateMediaInput!]){productUpdate(product:$product,media:$media){product{id} userErrors{message}}}`,
    { product: { id: variant.product.id, ...productInput(product, status) }, media: [] },
  );
  if (updated.productUpdate.userErrors.length)
    throw new Error(
      updated.productUpdate.userErrors.map((e) => e.message).join("; "),
    );
  const result = await shopifyGraphql<{
    productVariantsBulkUpdate: {
      productVariants: ManagedVariant[];
      userErrors: Array<{ message: string }>;
    };
  }>(
    `mutation UpdateVariant($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants){productVariants{id sku barcode price product{id title} inventoryItem{id tracked}} userErrors{message}}}`,
    {
      productId: variant.product.id,
      variants: [
        {
          id: variant.id,
          price: String(product.basePrice ?? 0),
          barcode: product.barCode || null,
          inventoryItem: inventoryItemInput(product),
        },
      ],
    },
  );
  if (
    result.productVariantsBulkUpdate.userErrors.length ||
    !result.productVariantsBulkUpdate.productVariants[0]
  )
    throw new Error(
      result.productVariantsBulkUpdate.userErrors
        .map((e) => e.message)
        .join("; ") || "Shopify did not update the variant",
    );
  const saved = result.productVariantsBulkUpdate.productVariants[0];
  await checkpoint?.(saved);
  if (syncMedia) await syncShopifyProductMedia(variant.product.id, product);
  return saved;
}

type ManagedVariantGroup = { productId: string; variants: ManagedVariant[] };

export function variantGroupInput(
  products: KiotVietProduct[],
  existingBySku: Map<string, string> = new Map(),
) {
  const optionNames = [
    ...new Set(
      products
        .flatMap((product) =>
          (product.attributes ?? []).map((attribute) =>
            attribute.attributeName.trim(),
          ),
        )
        .filter(Boolean),
    ),
  ];
  if (!optionNames.length)
    throw new Error("KiotViet variant group has no attributes");
  if (optionNames.length > 3)
    throw new Error("Shopify supports at most 3 product options");
  const valuesByOption = new Map(
    optionNames.map((name) => [name, new Set<string>()]),
  );
  const combinations = new Set<string>();
  const variants = products.map((product) => {
    const attributes = new Map(
      (product.attributes ?? []).map((attribute) => [
        attribute.attributeName.trim(),
        attribute.attributeValue.trim(),
      ]),
    );
    const optionValues = optionNames.map((optionName) => {
      const name = attributes.get(optionName);
      if (!name)
        throw new Error(
          `Variant ${product.code} is missing option ${optionName}`,
        );
      valuesByOption.get(optionName)!.add(name);
      return { optionName, name };
    });
    const combination = optionValues
      .map((item) => `${item.optionName}:${item.name}`)
      .join("|");
    if (combinations.has(combination))
      throw new Error(`Duplicate KiotViet variant combination: ${combination}`);
    combinations.add(combination);
    const id = existingBySku.get(product.code.trim().toUpperCase());
    return {
      ...(id ? { id } : {}),
      sku: product.code,
      barcode: product.barCode || null,
      price: String(product.basePrice ?? 0),
      optionValues,
      inventoryItem: inventoryItemInput(product),
    };
  });
  return {
    productOptions: optionNames.map((name, index) => ({
      name,
      position: index + 1,
      values: [...valuesByOption.get(name)!].map((value) => ({ name: value })),
    })),
    variants,
  };
}

export async function setShopifyVariantGroup(
  products: KiotVietProduct[],
  existingProductId?: string,
  options: {
    checkpoint?: (group: ManagedVariantGroup) => Promise<void>;
    resumeFields?: boolean;
    status?: ProductStatus;
  } = {},
): Promise<ManagedVariantGroup> {
  if (!products.length)
    throw new Error("Cannot synchronize an empty variant group");
  if (!existingProductId && !options.checkpoint)
    throw new Error("Creating a variant family requires an identity checkpoint");
  const primary =
    products.find((product) => !product.masterProductId) ?? products[0];
  const existing = existingProductId
    ? await shopifyGraphql<{
        product: {
          metafield: { value: string } | null;
          variants: { nodes: ManagedVariant[] };
        } | null;
      }>(
        `query ExistingProductVariants($id:ID!){product(id:$id){metafield(namespace:"kiotviet_sync",key:"variant_fields_hash"){value} variants(first:250){nodes{id sku barcode price product{id title} inventoryItem{id tracked}}}}}`,
        { id: existingProductId },
      )
    : undefined;
  const existingBySku = new Map(
    (existing?.product?.variants.nodes ?? []).map((variant) => [
      variant.sku.trim().toUpperCase(),
      variant.id,
    ]),
  );
  const group = variantGroupInput(products, existingBySku);
  const input = productInput(primary, options.status ?? await resolveProductStatus(products));
  const fieldsHash = syncHash({ ...input, ...variantGroupInput(products) });
  if (options.resumeFields && existingProductId && existing?.product?.metafield?.value === fieldsHash &&
    existing.product.variants.nodes.length === products.length &&
    products.every((product) => existingBySku.has(product.code.trim().toUpperCase()))) {
    const saved = { productId: existingProductId, variants: existing.product.variants.nodes };
    await options.checkpoint?.(saved);
    await syncShopifyProductMedia(existingProductId, primary);
    return saved;
  }
  const result = await shopifyGraphql<{
    productSet: {
      product?: {
        id: string;
        title: string;
        variants: { nodes: ManagedVariant[] };
      };
      userErrors: Array<{ field?: string[]; message: string }>;
    };
  }>(
    `mutation SetVariantProduct($identifier:ProductSetIdentifiers,$input:ProductSetInput!){productSet(identifier:$identifier,input:$input,synchronous:true){product{id title variants(first:250){nodes{id sku barcode price product{id title} inventoryItem{id tracked}}}} userErrors{field message}}}`,
    {
      identifier: existingProductId ? { id: existingProductId } : null,
      input: {
        ...input,
        productOptions: group.productOptions,
        variants: group.variants,
      },
    },
  );
  const errors = result.productSet.userErrors;
  if (errors.length || !result.productSet.product)
    throw new Error(
      errors.map((error) => error.message).join("; ") ||
        "Shopify did not set the variant product",
    );
  const saved = result.productSet.product;
  const identities = { productId: saved.id, variants: saved.variants.nodes };
  // Identity must be durable before the field marker or asynchronous media work.
  try {
    await options.checkpoint?.(identities);
  } catch (error) {
    if (!existingProductId) return cleanupUncheckpointedProduct(saved.id, error);
    throw error;
  }
  if (options.checkpoint) {
    // Use productUpdate: productSet's metafields list can replace other metadata.
    const marked = await shopifyGraphql<{
      productUpdate: { product: { id: string } | null; userErrors: Array<{ message: string }> };
    }>(
      `mutation CheckpointVariantFields($product:ProductUpdateInput!){productUpdate(product:$product){product{id} userErrors{message}}}`,
      { product: { id: saved.id, metafields: [{ namespace: "kiotviet_sync", key: "variant_fields_hash", type: "single_line_text_field", value: fieldsHash }] } },
    );
    if (marked.productUpdate.userErrors.length || !marked.productUpdate.product)
      throw new Error(marked.productUpdate.userErrors.map((error) => error.message).join("; ") || "Shopify did not checkpoint variant fields");
  }
  await syncShopifyProductMedia(saved.id, primary);
  return identities;
}

export async function shopifyProductHasCustomOptions(productId: string) {
  const data = await shopifyGraphql<{
    product: { hasOnlyDefaultVariant: boolean } | null;
  }>(`query ProductShape($id:ID!){product(id:$id){hasOnlyDefaultVariant}}`, {
    id: productId,
  });
  return data.product ? !data.product.hasOnlyDefaultVariant : false;
}

export async function collapseShopifyVariantGroup(
  product: KiotVietProduct,
  productId: string,
  checkpoint?: (variant: ManagedVariant) => Promise<void>,
  status?: ProductStatus,
): Promise<ManagedVariant> {
  status ??= await resolveProductStatus([product]);
  const result = await shopifyGraphql<{
    productSet: {
      product?: {
        id: string;
        title: string;
        variants: { nodes: ManagedVariant[] };
      };
      userErrors: Array<{ message: string }>;
    };
  }>(
    `mutation CollapseVariantProduct($identifier:ProductSetIdentifiers!,$input:ProductSetInput!){productSet(identifier:$identifier,input:$input,synchronous:true){product{id title variants(first:1){nodes{id sku barcode price product{id title} inventoryItem{id tracked}}}} userErrors{message}}}`,
    {
      identifier: { id: productId },
      input: { ...productInput(product, status), productOptions: [], variants: [] },
    },
  );
  const errors = result.productSet.userErrors;
  const defaultVariant = result.productSet.product?.variants.nodes[0];
  if (errors.length || !defaultVariant)
    throw new Error(
      errors.map((error) => error.message).join("; ") ||
        "Shopify did not collapse the variant product",
    );
  return updateShopifyProduct(product, defaultVariant, true, checkpoint, status);
}

export async function archiveShopifyProduct(productId: string) {
  const result = await shopifyGraphql<{
    productUpdate: {
      product?: { id: string; status: string };
      userErrors: Array<{ message: string }>;
    };
  }>(
    `mutation ArchiveSyncedProduct($product:ProductUpdateInput!){productUpdate(product:$product){product{id status} userErrors{message}}}`,
    { product: { id: productId, status: "ARCHIVED" } },
  );
  if (result.productUpdate.userErrors.length || !result.productUpdate.product)
    throw new Error(
      result.productUpdate.userErrors
        .map((error) => error.message)
        .join("; ") || "Shopify did not archive the product",
    );
}

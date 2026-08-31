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

type ManagedVariant = ShopifyVariant & { price?: string };
function productInput(product: KiotVietProduct) {
  return {
    title: product.name,
    descriptionHtml: product.description ?? "",
    productType: product.categoryName ?? "",
    vendor: "KiotViet",
    status:
      product.isActive === false || product.allowsSale === false
        ? "DRAFT"
        : "ACTIVE",
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
function productMedia(product: KiotVietProduct) {
  return (product.images ?? [])
    .filter((url) => {
      try {
        return new URL(url).protocol === "https:";
      } catch {
        return false;
      }
    })
    .slice(0, 20)
    .map((originalSource) => ({
      originalSource,
      alt: product.name,
      mediaContentType: "IMAGE" as const,
    }));
}
async function productHasMedia(productId: string) {
  const data = await shopifyGraphql<{
    product: { media: { nodes: Array<{ id: string }> } } | null;
  }>(
    `query ProductMedia($id:ID!){product(id:$id){media(first:1){nodes{id}}}}`,
    { id: productId },
  );
  return Boolean(data.product?.media.nodes.length);
}

export async function createShopifyProduct(
  product: KiotVietProduct,
): Promise<ManagedVariant> {
  const created = await shopifyGraphql<{
    productCreate: {
      product?: { id: string; variants: { nodes: Array<{ id: string }> } };
      userErrors: Array<{ message: string }>;
    };
  }>(
    `mutation CreateProduct($product:ProductCreateInput!,$media:[CreateMediaInput!]){productCreate(product:$product,media:$media){product{id variants(first:1){nodes{id}}} userErrors{message}}}`,
    { product: productInput(product), media: productMedia(product) },
  );
  if (created.productCreate.userErrors.length || !created.productCreate.product)
    throw new Error(
      created.productCreate.userErrors.map((e) => e.message).join("; ") ||
        "Shopify did not create the product",
    );
  const shopifyProduct = created.productCreate.product,
    variantId = shopifyProduct.variants.nodes[0]?.id;
  if (!variantId) throw new Error("Shopify product has no default variant");
  try {
    return await updateShopifyProduct(
      product,
      {
        id: variantId,
        sku: product.code,
        product: { id: shopifyProduct.id, title: product.name },
        inventoryItem: { id: "", tracked: true },
      },
      false,
    );
  } catch (error) {
    await shopifyGraphql(
      `mutation Cleanup($input:ProductDeleteInput!){productDelete(input:$input){deletedProductId}}`,
      { input: { id: shopifyProduct.id } },
    ).catch(() => undefined);
    throw error;
  }
}

export async function updateShopifyProduct(
  product: KiotVietProduct,
  variant: ShopifyVariant,
  addMissingMedia = true,
): Promise<ManagedVariant> {
  const media =
    addMissingMedia && !(await productHasMedia(variant.product.id))
      ? productMedia(product)
      : [];
  const updated = await shopifyGraphql<{
    productUpdate: {
      product?: { id: string };
      userErrors: Array<{ message: string }>;
    };
  }>(
    `mutation UpdateProduct($product:ProductUpdateInput!,$media:[CreateMediaInput!]){productUpdate(product:$product,media:$media){product{id} userErrors{message}}}`,
    { product: { id: variant.product.id, ...productInput(product) }, media },
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
  return result.productVariantsBulkUpdate.productVariants[0];
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
): Promise<ManagedVariantGroup> {
  if (!products.length)
    throw new Error("Cannot synchronize an empty variant group");
  const primary =
    products.find((product) => !product.masterProductId) ?? products[0];
  const existing = existingProductId
    ? await shopifyGraphql<{
        product: {
          variants: { nodes: Array<{ id: string; sku: string }> };
        } | null;
      }>(
        `query ExistingProductVariants($id:ID!){product(id:$id){variants(first:250){nodes{id sku}}}}`,
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
        ...productInput(primary),
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
  if (productMedia(primary).length && !(await productHasMedia(saved.id))) {
    const mediaResult = await shopifyGraphql<{
      productUpdate: { userErrors: Array<{ message: string }> };
    }>(
      `mutation AddVariantProductMedia($product:ProductUpdateInput!,$media:[CreateMediaInput!]){productUpdate(product:$product,media:$media){userErrors{message}}}`,
      { product: { id: saved.id }, media: productMedia(primary) },
    );
    if (mediaResult.productUpdate.userErrors.length)
      throw new Error(
        mediaResult.productUpdate.userErrors
          .map((error) => error.message)
          .join("; "),
      );
  }
  return { productId: saved.id, variants: saved.variants.nodes };
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
): Promise<ManagedVariant> {
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
      input: { ...productInput(product), productOptions: [], variants: [] },
    },
  );
  const errors = result.productSet.userErrors;
  const defaultVariant = result.productSet.product?.variants.nodes[0];
  if (errors.length || !defaultVariant)
    throw new Error(
      errors.map((error) => error.message).join("; ") ||
        "Shopify did not collapse the variant product",
    );
  return updateShopifyProduct(product, defaultVariant, false);
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

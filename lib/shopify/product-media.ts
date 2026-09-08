import { shopifyGraphql } from "./graphql";
import { RetryableError } from "@/lib/errors";
import type { KiotVietProduct } from "@/lib/kiotviet/types";

type Media = {
  id: string;
  mediaContentType: string;
  status: string;
  image?: { url: string } | null;
  originalSource?: { url: string } | null;
};
type Source = { id: string; source: string; imageUrl?: string };
const namespace = "kiotviet_sync";
const key = "product_media_sources";
const mediaFields = "id mediaContentType status ... on MediaImage { image { url } originalSource { url } }";

export function normalizeKiotVietMedia(product: KiotVietProduct): string[] {
  return (product.images ?? []).filter((url) => {
    try {
      return typeof url === "string" && new URL(url).protocol === "https:";
    } catch {
      return false;
    }
  }).slice(0, 20);
}

function parseSources(value?: string): Source[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) =>
      item && typeof item.id === "string" && typeof item.source === "string" &&
      (item.imageUrl === undefined || typeof item.imageUrl === "string"),
    )) return parsed;
  } catch { /* An invalid checkpoint cannot establish source identity. */ }
  return [];
}

export async function getShopifyProductMedia(productId: string) {
  const media: Media[] = [];
  let sources: Source[] = [];
  let after: string | null = null;
  do {
    const data: { product: {
      metafield: { value: string } | null;
      media: { nodes: Media[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    } | null } = await shopifyGraphql(
      `query ProductMedia($id:ID!,$after:String){product(id:$id){metafield(namespace:"${namespace}",key:"${key}"){value} media(first:250,after:$after){nodes{${mediaFields}} pageInfo{hasNextPage endCursor}}}}`,
      { id: productId, after },
    );
    if (!data.product) throw new Error(`Shopify product ${productId} does not exist`);
    if (!after) sources = parseSources(data.product.metafield?.value);
    media.push(...data.product.media.nodes);
    const page = data.product.media.pageInfo;
    if (page.hasNextPage && (!page.endCursor || page.endCursor === after))
      throw new Error("Shopify media pagination did not advance");
    after = page.hasNextPage ? page.endCursor : null;
  } while (after);
  return { media, sources };
}

export function mediaMatches(media: Media[], desired: string[], sources: Source[] = []) {
  return media.length === desired.length && media.every((item, index) => {
    if (item.mediaContentType !== "IMAGE" || item.status === "FAILED") return false;
    const source = sources[index];
    // Shopify's originalSource is a temporary Shopify URL, not the KiotViet
    // upload URL. Never infer identity from filenames or strip query strings.
    return item.image?.url === desired[index] || item.originalSource?.url === desired[index] ||
      (source?.id === item.id && source.source === desired[index] &&
        (!source.imageUrl || source.imageUrl === item.image?.url));
  });
}

async function saveSources(productId: string, sources: Source[]) {
  const result = await shopifyGraphql<{
    productUpdate: { product: { id: string } | null; userErrors: Array<{ message: string }> };
  }>(
    `mutation SaveProductMediaSources($product:ProductUpdateInput!){productUpdate(product:$product){product{id} userErrors{message}}}`,
    { product: { id: productId, metafields: [{ namespace, key, type: "json", value: JSON.stringify(sources) }] } },
  );
  if (result.productUpdate.userErrors.length || !result.productUpdate.product)
    throw new Error(result.productUpdate.userErrors.map((e) => e.message).join("; ") || "Shopify did not save media sources");
}

async function verifyMedia(productId: string, desired: string[], sources: Source[]) {
  // Upload acceptance is not success: Shopify processes images asynchronously.
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = await getShopifyProductMedia(productId);
    if (!mediaMatches(current.media, desired, sources))
      throw new Error("Shopify media creation failed or media changed during synchronization");
    if (current.media.every((item) => item.status === "READY" && item.image?.url)) {
      const complete = current.media.map((item, index) => ({
        id: item.id, source: desired[index], imageUrl: item.image!.url,
      }));
      if (JSON.stringify(complete) !== JSON.stringify(current.sources))
        await saveSources(productId, complete);
      return;
    }
    if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new RetryableError("Shopify product media is still processing");
}

export async function syncShopifyProductMedia(productId: string, product: KiotVietProduct) {
  const desired = normalizeKiotVietMedia(product);
  const current = await getShopifyProductMedia(productId);
  if (mediaMatches(current.media, desired, current.sources)) {
    if (current.media.every((item) => item.status === "READY" && item.image?.url)) {
      // Complete a checkpoint left by a processing timeout, using this read.
      if (current.sources.length === desired.length && current.sources.some((source) => !source.imageUrl))
        await saveSources(productId, current.media.map((item, index) => ({
          id: item.id, source: desired[index], imageUrl: item.image!.url,
        })));
      return;
    }
    await verifyMedia(productId, desired, current.sources);
    return;
  }

  // API 2026-07 compatibility: fileUpdate is preferred but requires write_files
  // (or write_themes), neither in this repo's scopes. productDeleteMedia is
  // deprecated but still supported with write_products. Do not delete global files.
  for (let offset = 0; offset < current.media.length; offset += 250) {
    const mediaIds = current.media.slice(offset, offset + 250).map((item) => item.id);
    const result = await shopifyGraphql<{
      productDeleteMedia: { deletedMediaIds: string[] | null; mediaUserErrors: Array<{ message: string }> };
    }>(
      `mutation DeleteProductMedia($productId:ID!,$mediaIds:[ID!]!){productDeleteMedia(productId:$productId,mediaIds:$mediaIds){deletedMediaIds mediaUserErrors{message}}}`,
      { productId, mediaIds },
    );
    const deleted = result.productDeleteMedia;
    if (deleted.mediaUserErrors.length || mediaIds.some((id) => !deleted.deletedMediaIds?.includes(id)))
      throw new Error(deleted.mediaUserErrors.map((e) => e.message).join("; ") || "Shopify did not delete all product media");
  }

  const sources: Source[] = [];
  // Append serially: each returned ID is tied to exactly one source URL and
  // insertion order is independent of asynchronous image processing order.
  for (const originalSource of desired) {
    const result = await shopifyGraphql<{
      productUpdate: { product: { media: { nodes: Media[] } } | null; userErrors: Array<{ message: string }> };
    }>(
      `mutation CreateProductMedia($product:ProductUpdateInput!,$media:[CreateMediaInput!]){productUpdate(product:$product,media:$media){product{media(first:250){nodes{${mediaFields}}}} userErrors{message}}}`,
      { product: { id: productId }, media: [{ originalSource, alt: product.name, mediaContentType: "IMAGE" }] },
    );
    const updated = result.productUpdate;
    if (updated.userErrors.length || !updated.product)
      throw new Error(updated.userErrors.map((e) => e.message).join("; ") || "Shopify did not create product media");
    const nodes = updated.product.media.nodes;
    const added = nodes[sources.length];
    if (nodes.length !== sources.length + 1 || !added || added.status === "FAILED" ||
      sources.some((source, index) => nodes[index].id !== source.id))
      throw new Error("Shopify did not append product media in source order");
    sources.push({ id: added.id, source: originalSource });
  }
  // Persist IDs before polling, so a retry can wait for pending uploads instead
  // of uploading them again. Partial/failed creation never marks the sync hash.
  await saveSources(productId, sources);
  await verifyMedia(productId, desired, sources);
}

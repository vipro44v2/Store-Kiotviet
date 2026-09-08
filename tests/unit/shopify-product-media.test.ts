import { beforeEach, describe, expect, it, vi } from "vitest";

const graphql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/shopify/graphql", () => ({ shopifyGraphql: graphql }));

import { getShopifyProductMedia, normalizeKiotVietMedia, syncShopifyProductMedia } from "@/lib/shopify/product-media";
import { collapseShopifyVariantGroup, createShopifyProduct, setShopifyVariantGroup, updateShopifyProduct } from "@/lib/shopify/products";
import type { KiotVietProduct } from "@/lib/kiotviet/types";

const a = "https://kiotviet.example/a.jpg";
const b = "https://kiotviet.example/b.jpg";
const c = "https://kiotviet.example/c.jpg";
const product: KiotVietProduct = { id: 1, code: "A", name: "Product", images: [a, b] };
const variant = { id: "v1", sku: "A", product: { id: "p1", title: "Product" }, inventoryItem: { id: "i1", tracked: true } };
type TestMedia = { id: string; mediaContentType: string; status: string; image: { url: string }; originalSource?: { url: string } };
let media: TestMedia[];
let checkpoint: string | null;
let sequence: number;
let deleteError: boolean;
let createError: boolean;
let failedUpload: boolean;
let pendingUpload: boolean;
const calls = (name: string) => graphql.mock.calls.filter(([query]) => query.includes(`mutation ${name}(`));

beforeEach(() => {
  graphql.mockReset();
  media = [];
  checkpoint = null;
  sequence = 0;
  deleteError = createError = failedUpload = pendingUpload = false;
  graphql.mockImplementation(async (query: string, variables: {
    mediaIds: string[];
    product: { metafields: Array<{ value: string }> };
  }) => {
    if (query.includes("query ProductMedia(")) return { product: {
      metafield: checkpoint ? { value: checkpoint } : null,
      media: { nodes: structuredClone(media), pageInfo: { hasNextPage: false, endCursor: null } },
    } };
    if (query.includes("mutation DeleteProductMedia(")) {
      if (deleteError) return { productDeleteMedia: { deletedMediaIds: [], mediaUserErrors: [{ message: "delete denied" }] } };
      media = media.filter((item) => !variables.mediaIds.includes(item.id));
      return { productDeleteMedia: { deletedMediaIds: variables.mediaIds, mediaUserErrors: [] } };
    }
    if (query.includes("mutation CreateProductMedia(")) {
      if (createError) return { productUpdate: { product: null, userErrors: [{ message: "invalid source" }] } };
      media.push({ id: `m${++sequence}`, mediaContentType: "IMAGE", status: failedUpload ? "FAILED" : pendingUpload ? "PROCESSING" : "READY", image: { url: `https://cdn.shopify.com/${sequence}.jpg` } });
      return { productUpdate: { product: { media: { nodes: structuredClone(media) } }, userErrors: [] } };
    }
    if (query.includes("mutation SaveProductMediaSources(")) {
      checkpoint = variables.product.metafields[0].value;
      return { productUpdate: { product: { id: "p1" }, userErrors: [] } };
    }
    if (query.includes("mutation UpdateProduct(")) return { productUpdate: { product: { id: "p1" }, userErrors: [] } };
    if (query.includes("mutation UpdateVariant(")) return { productVariantsBulkUpdate: { productVariants: [variant], userErrors: [] } };
    if (query.includes("mutation CreateProduct(")) return { productCreate: { product: { id: "p1", variants: { nodes: [variant] } }, userErrors: [] } };
    if (query.includes("query ExistingProductVariants(")) return { product: { variants: { nodes: [variant] } } };
    if (query.includes("mutation SetVariantProduct(") || query.includes("mutation CollapseVariantProduct("))
      return { productSet: { product: { id: "p1", variants: { nodes: [variant] } }, userErrors: [] } };
    throw new Error(`Unexpected query: ${query}`);
  });
});

function existing(urls: string[]) {
  media = urls.map((url, index) => ({ id: `old${index}`, mediaContentType: "IMAGE", status: "READY", image: { url } }));
}

describe("product media reconciliation", () => {
  it.each([
    ["empty Shopify", [], [a, b]],
    ["different images", [c], [a, b]],
    ["one image changed", [a, b], [a, c]],
    ["order changed", [a, b], [b, a]],
    ["image added", [a], [a, b]],
    ["image removed", [a, b], [b]],
    ["all images removed", [a, b], []],
  ])("replaces exactly: %s", async (_label, old, desired) => {
    existing(old as string[]);
    await syncShopifyProductMedia("p1", { ...product, images: desired as string[] });
    expect(media).toHaveLength(desired.length);
    expect(calls("DeleteProductMedia")).toHaveLength(old.length ? 1 : 0);
    expect(calls("CreateProductMedia").map(([, variables]) => variables.media[0].originalSource)).toEqual(desired);
    expect(JSON.parse(checkpoint!).map((item: { source: string }) => item.source)).toEqual(desired);
    const firstCreate = graphql.mock.calls.findIndex(([query]) => query.includes("mutation CreateProductMedia("));
    const lastDelete = graphql.mock.calls.findIndex(([query]) => query.includes("mutation DeleteProductMedia("));
    if (old.length && desired.length) expect(firstCreate).toBeGreaterThan(lastDelete);
  });

  it.each([[a, b], []])("makes only a read when media already matches %j", async (...urls) => {
    existing(urls);
    await syncShopifyProductMedia("p1", { ...product, images: urls });
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("skips CDN images on subsequent sync, even when temporary originalSource changes", async () => {
    await syncShopifyProductMedia("p1", product);
    media.forEach((item) => { item.originalSource = { url: "https://shopify.example/signed?expires=new" }; });
    graphql.mockClear();
    await syncShopifyProductMedia("p1", product);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("detects CDN media reorder despite unchanged checkpoint", async () => {
    await syncShopifyProductMedia("p1", product);
    media.reverse();
    graphql.mockClear();
    await syncShopifyProductMedia("p1", product);
    expect(calls("DeleteProductMedia")).toHaveLength(1);
    expect(calls("CreateProductMedia")).toHaveLength(2);
  });

  it("filters invalid and non-HTTPS URLs before limiting to 20, preserving order", () => {
    const urls = Array.from({ length: 25 }, (_, index) => `https://example.com/${index}?v=1`);
    expect(normalizeKiotVietMedia({ ...product, images: ["bad", "http://example.com/a", "https://", "ftp://example.com/a", ...urls] })).toEqual(urls.slice(0, 20));
  });

  it("does not create after deletion errors", async () => {
    existing([c]); deleteError = true;
    await expect(syncShopifyProductMedia("p1", product)).rejects.toThrow("delete denied");
    expect(calls("CreateProductMedia")).toHaveLength(0);
    expect(calls("SaveProductMediaSources")).toHaveLength(0);
  });

  it("rejects incomplete deletion even without userErrors", async () => {
    existing([c]);
    graphql.mockResolvedValueOnce({ product: { metafield: null, media: { nodes: media, pageInfo: { hasNextPage: false } } } })
      .mockResolvedValueOnce({ productDeleteMedia: { deletedMediaIds: [], mediaUserErrors: [] } });
    await expect(syncShopifyProductMedia("p1", product)).rejects.toThrow("did not delete all");
    expect(calls("CreateProductMedia")).toHaveLength(0);
  });

  it("throws create errors and retries without accumulating images", async () => {
    existing([c]); createError = true;
    await expect(syncShopifyProductMedia("p1", product)).rejects.toThrow("invalid source");
    expect(checkpoint).toBeNull();
    createError = false;
    await syncShopifyProductMedia("p1", product);
    expect(media).toHaveLength(2);
  });

  it("rejects asynchronous failed uploads", async () => {
    failedUpload = true;
    await expect(syncShopifyProductMedia("p1", product)).rejects.toThrow("did not append");
    expect(checkpoint).toBeNull();
  });

  it("removes a partially created set before retrying", async () => {
    const implementation = graphql.getMockImplementation()!;
    let uploads = 0;
    graphql.mockImplementation(async (...args) => {
      if (args[0].includes("mutation CreateProductMedia(") && ++uploads === 2)
        throw new Error("network failed");
      return implementation(...args);
    });
    await expect(syncShopifyProductMedia("p1", product)).rejects.toThrow("network failed");
    expect(media).toHaveLength(1);
    expect(checkpoint).toBeNull();
    graphql.mockImplementation(implementation);
    await syncShopifyProductMedia("p1", product);
    expect(media).toHaveLength(2);
    expect(calls("DeleteProductMedia")).toHaveLength(1);
  });

  it("propagates checkpoint errors instead of reporting success", async () => {
    const implementation = graphql.getMockImplementation()!;
    graphql.mockImplementation(async (...args) => {
      if (args[0].includes("mutation SaveProductMediaSources("))
        return { productUpdate: { product: null, userErrors: [{ message: "metafield failed" }] } };
      return implementation(...args);
    });
    await expect(syncShopifyProductMedia("p1", product)).rejects.toThrow("metafield failed");
  });

  it("does not confuse URLs with the same filename or different query strings", async () => {
    existing([`${a}?v=1`]);
    await syncShopifyProductMedia("p1", { ...product, images: [`${a}?v=2`] });
    expect(calls("DeleteProductMedia")).toHaveLength(1);
  });

  it("keeps pending upload IDs for retry and does not re-upload", async () => {
    vi.useFakeTimers();
    try {
      pendingUpload = true;
      const sync = expect(syncShopifyProductMedia("p1", product)).rejects.toThrow("still processing");
      await vi.runAllTimersAsync();
      await sync;
      expect(checkpoint).not.toBeNull();
      media.forEach((item) => { item.status = "READY"; });
      graphql.mockClear();
      await syncShopifyProductMedia("p1", product);
      expect(calls("CreateProductMedia")).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it("paginates all existing media in order", async () => {
    existing([a, b]);
    graphql.mockResolvedValueOnce({ product: { metafield: null, media: { nodes: media.slice(0, 1), pageInfo: { hasNextPage: true, endCursor: "cursor" } } } })
      .mockResolvedValueOnce({ product: { metafield: null, media: { nodes: media.slice(1), pageInfo: { hasNextPage: false, endCursor: null } } } });
    expect((await getShopifyProductMedia("p1")).media).toEqual(media);
    expect(graphql.mock.calls[1][1]).toEqual({ id: "p1", after: "cursor" });
  });

  it("uses master media once for a variant family", async () => {
    await setShopifyVariantGroup([
      { ...product, id: 2, code: "B", masterProductId: 1, images: [c], attributes: [{ attributeName: "Size", attributeValue: "L" }] },
      { ...product, attributes: [{ attributeName: "Size", attributeValue: "S" }] },
    ], "p1");
    expect(calls("CreateProductMedia").map(([, variables]) => variables.media[0].originalSource)).toEqual([a, b]);
    expect(calls("SetVariantProduct")).toHaveLength(1);
  });

  it("syncs images when collapsing a family", async () => {
    existing([c]);
    await collapseShopifyVariantGroup(product, "p1");
    expect(calls("DeleteProductMedia")).toHaveLength(1);
    expect(calls("CreateProductMedia")).toHaveLength(2);
  });

  it("creates product images once and records their source", async () => {
    await createShopifyProduct(product);
    expect(calls("CreateProduct")[0][1].media).toEqual([]);
    expect(calls("CreateProductMedia")).toHaveLength(2);
    expect(checkpoint).not.toBeNull();
  });

  it("preserves product and variant fields when syncing images", async () => {
    await updateShopifyProduct({ ...product, description: "Description", basePrice: 123, barCode: "barcode", weight: 250, isActive: false }, variant);
    expect(calls("UpdateProduct")[0][1].product).toMatchObject({ id: "p1", title: product.name, descriptionHtml: "Description", status: "DRAFT" });
    expect(calls("UpdateVariant")[0][1].variants[0]).toMatchObject({ id: "v1", price: "123", barcode: "barcode", inventoryItem: { sku: "A", tracked: true, measurement: { weight: { value: 250, unit: "GRAMS" } } } });
  });
});

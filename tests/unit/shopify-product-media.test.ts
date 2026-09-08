import { beforeEach, describe, expect, it, vi } from "vitest";

const graphql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/shopify/graphql", () => ({ shopifyGraphql: graphql }));
const syncMocks = vi.hoisted(() => ({
  getProduct: vi.fn(), getFamily: vi.fn(), findBySku: vi.fn(), upsert: vi.fn(), query: vi.fn(),
}));
vi.mock("@/lib/kiotviet/products", () => ({ getKiotVietProduct: syncMocks.getProduct, getKiotVietVariantFamily: syncMocks.getFamily }));
vi.mock("@/repositories/mappings", () => ({ mappingsRepository: { findBySku: syncMocks.findBySku, upsertExact: syncMocks.upsert } }));
vi.mock("@/lib/db/client", () => ({ query: syncMocks.query }));
vi.mock("@/lib/logger", () => ({ log: vi.fn() }));
vi.mock("@/lib/sync/inventory-sync", () => ({ syncInventoryNotification: vi.fn() }));

import { getShopifyProductMedia, normalizeKiotVietMedia, syncShopifyProductMedia } from "@/lib/shopify/product-media";
import { collapseShopifyVariantGroup, createShopifyProduct, setShopifyVariantGroup, updateShopifyProduct } from "@/lib/shopify/products";
import type { KiotVietProduct } from "@/lib/kiotviet/types";
import type { MappingRecord } from "@/repositories/mappings";
import { syncKiotVietProductToShopify } from "@/lib/sync/kiotviet-product-sync";
import { RetryableError } from "@/lib/errors";

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
let persisted: MappingRecord[];
let storedVariant: typeof variant | undefined;
let familyVariants: Array<typeof variant>;
let fieldsHash: string | null;
let updatedTitle: string;
let updatedPrice: string;
const calls = (name: string) => graphql.mock.calls.filter(([query]) => query.includes(`mutation ${name}(`));

beforeEach(() => {
  graphql.mockReset();
  Object.values(syncMocks).forEach((mock) => mock.mockReset());
  persisted = [];
  storedVariant = undefined;
  familyVariants = [variant];
  fieldsHash = null;
  updatedTitle = "Old title";
  updatedPrice = "0";
  const source = { ...product, inventories: [{ branchId: 1, branchName: "Main", onHand: 5 }] };
  syncMocks.getProduct.mockResolvedValue(source);
  syncMocks.getFamily.mockResolvedValue([source]);
  syncMocks.findBySku.mockImplementation(async (sku) => structuredClone(persisted.filter((item) => item.normalized_sku === sku)));
  syncMocks.upsert.mockImplementation(async (input, options) => {
    const previous = persisted.find((item) => item.normalized_sku === input.normalized_sku);
    persisted = persisted.filter((item) => item.normalized_sku !== input.normalized_sku);
    persisted.push({ ...input, id: `mapping-${input.normalized_sku}`, sync_status: "mapped", last_sync_hash: options?.resetSyncHash ? null : previous?.last_sync_hash ?? null });
  });
  syncMocks.query.mockImplementation(async (_sql, values) => {
    const mapping = persisted.find((item) => item.normalized_sku === values[0])!;
    mapping.last_sync_hash = values[2];
    mapping.sync_status = values[2] === null ? "mapped" : "synced";
    return [];
  });
  media = [];
  checkpoint = null;
  sequence = 0;
  deleteError = createError = failedUpload = pendingUpload = false;
  graphql.mockImplementation(async (query: string, variables: {
    mediaIds: string[];
    product: { title: string; metafields: Array<{ value: string }> };
    variants: Array<{ price: string }>;
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
    if (query.includes("mutation UpdateProduct(")) {
      updatedTitle = variables.product.title;
      return { productUpdate: { product: { id: "p1" }, userErrors: [] } };
    }
    if (query.includes("mutation UpdateVariant(")) {
      storedVariant = variant;
      updatedPrice = variables.variants[0].price;
      return { productVariantsBulkUpdate: { productVariants: [variant], userErrors: [] } };
    }
    if (query.includes("mutation CreateProduct(")) {
      storedVariant = { ...variant, sku: "" };
      return { productCreate: { product: { id: "p1", variants: { nodes: [storedVariant] } }, userErrors: [] } };
    }
    if (query.includes("query BySku(")) return { productVariants: { nodes: storedVariant?.sku ? [storedVariant] : [] } };
    if (query.includes("query ProductVariant(")) return { productVariant: storedVariant ?? null };
    if (query.includes("query ProductExists(")) return { product: { id: "p1" } };
    if (query.includes("query ProductShape(")) return { product: { hasOnlyDefaultVariant: true } };
    if (query.includes("mutation Cleanup(")) {
      storedVariant = undefined;
      return { productDelete: { deletedProductId: "p1", userErrors: [] } };
    }
    if (query.includes("query ExistingProductVariants(")) return { product: { metafield: fieldsHash ? { value: fieldsHash } : null, variants: { nodes: familyVariants } } };
    if (query.includes("mutation CheckpointVariantFields(")) {
      fieldsHash = variables.product.metafields[0].value;
      return { productUpdate: { product: { id: "p1" }, userErrors: [] } };
    }
    if (query.includes("mutation SetVariantProduct(") || query.includes("mutation CollapseVariantProduct("))
      return { productSet: { product: { id: "p1", variants: { nodes: familyVariants } }, userErrors: [] } };
    throw new Error(`Unexpected query: ${query}`);
  });
});

function existing(urls: string[]) {
  media = urls.map((url, index) => ({ id: `old${index}`, mediaContentType: "IMAGE", status: "READY", image: { url } }));
}

function variantFamily() {
  const family = [
    { ...product, hasVariants: true, attributes: [{ attributeName: "Size", attributeValue: "S" }] },
    { ...product, id: 2, code: "B", masterProductId: 1, attributes: [{ attributeName: "Size", attributeValue: "L" }] },
  ].map((item) => ({ ...item, inventories: [{ branchId: 1, branchName: "Main", onHand: 5 }] }));
  familyVariants = [variant, { ...variant, id: "v2", sku: "B", inventoryItem: { id: "i2", tracked: true } }];
  syncMocks.getProduct.mockResolvedValue(family[0]);
  syncMocks.getFamily.mockResolvedValue(family);
  return family;
}

describe("product media reconciliation", () => {
  it("creates a family once, checkpoints all identities before media, and resumes READY media", async () => {
    variantFamily();
    vi.useFakeTimers();
    try {
      pendingUpload = true;
      const failed = expect(syncKiotVietProductToShopify(1)).rejects.toBeInstanceOf(RetryableError);
      await vi.runAllTimersAsync();
      await failed;
      expect(persisted).toHaveLength(2);
      expect(persisted.map((item) => item.shopify_variant_id)).toEqual(["v1", "v2"]);
      for (const mapping of persisted)
        expect(mapping).toMatchObject({ shopify_product_id: "p1", last_sync_hash: null, sync_status: "mapped" });
      expect(syncMocks.query).not.toHaveBeenCalled();
      const firstMedia = graphql.mock.calls.findIndex(([query]) => query.includes("mutation CreateProductMedia("));
      expect(syncMocks.upsert.mock.invocationCallOrder[1]).toBeLessThan(graphql.mock.invocationCallOrder[firstMedia]);
      expect(calls("SetVariantProduct")).toHaveLength(1);
      expect(calls("Cleanup")).toHaveLength(0);
      media.forEach((item) => { item.status = "READY"; });
      await expect(syncKiotVietProductToShopify(2)).resolves.toMatchObject({ updated: true, variants: 2 });
      expect(calls("SetVariantProduct")).toHaveLength(1);
      expect(calls("CreateProductMedia")).toHaveLength(2);
      expect(calls("Cleanup")).toHaveLength(0);
      expect(new Set(persisted.map((item) => item.shopify_product_id))).toEqual(new Set(["p1"]));
      expect(new Set(persisted.map((item) => item.last_sync_hash)).size).toBe(1);
      for (const mapping of persisted)
        expect(mapping).toMatchObject({ sync_status: "synced", last_sync_hash: expect.any(String) });
    } finally { vi.useRealTimers(); }
  });

  it("applies changed family fields on retry to the checkpointed product", async () => {
    const family = variantFamily();
    vi.useFakeTimers();
    try {
      pendingUpload = true;
      const failed = expect(syncKiotVietProductToShopify(1)).rejects.toThrow("still processing");
      await vi.runAllTimersAsync();
      await failed;
      media.forEach((item) => { item.status = "READY"; });
      syncMocks.getFamily.mockResolvedValue(family.map((item) => ({ ...item, name: "Changed", basePrice: 999 })));
      await syncKiotVietProductToShopify(1);
      expect(calls("SetVariantProduct")).toHaveLength(2);
      expect(calls("SetVariantProduct")[1][1]).toMatchObject({ identifier: { id: "p1" }, input: { title: "Changed" } });
      expect(calls("SetVariantProduct").filter(([, args]) => args.identifier === null)).toHaveLength(1);
      expect(calls("CreateProductMedia")).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it("keeps family identities when the post-checkpoint field marker fails", async () => {
    variantFamily();
    const implementation = graphql.getMockImplementation()!;
    graphql.mockImplementation(async (...args) => {
      if (args[0].includes("mutation CheckpointVariantFields(")) throw new RetryableError("marker unavailable");
      return implementation(...args);
    });
    await expect(syncKiotVietProductToShopify(1)).rejects.toThrow("marker unavailable");
    expect(persisted).toHaveLength(2);
    expect(calls("Cleanup")).toHaveLength(0);
    expect(calls("CreateProductMedia")).toHaveLength(0);
    graphql.mockImplementation(implementation);
    await syncKiotVietProductToShopify(1);
    expect(calls("SetVariantProduct")[1][1].identifier).toEqual({ id: "p1" });
  });

  it("cleans up a new family if its identity checkpoint cannot be written", async () => {
    variantFamily();
    syncMocks.upsert.mockRejectedValueOnce(new Error("checkpoint database unavailable"));
    await expect(syncKiotVietProductToShopify(1)).rejects.toThrow("checkpoint database unavailable");
    expect(calls("Cleanup")).toHaveLength(1);
    expect(calls("CreateProductMedia")).toHaveLength(0);
  });

  it("updates existing title and price before media timeout and clears the old successful hash", async () => {
    await syncKiotVietProductToShopify(1);
    const changed = { ...product, name: "New title", basePrice: 456, images: [c], inventories: [{ branchId: 1, branchName: "Main", onHand: 5 }] };
    syncMocks.getProduct.mockResolvedValue(changed);
    syncMocks.getFamily.mockResolvedValue([changed]);
    graphql.mockClear();
    syncMocks.query.mockClear();
    vi.useFakeTimers();
    try {
      pendingUpload = true;
      const failed = expect(syncKiotVietProductToShopify(1)).rejects.toBeInstanceOf(RetryableError);
      await vi.runAllTimersAsync();
      await failed;
      expect(updatedTitle).toBe("New title");
      expect(updatedPrice).toBe("456");
      expect(persisted[0]).toMatchObject({ sync_status: "mapped", last_sync_hash: null });
      expect(syncMocks.query).not.toHaveBeenCalled();
      const operations = graphql.mock.calls.map(([query]) => query);
      expect(operations.findIndex((query) => query.includes("mutation UpdateVariant(")))
        .toBeLessThan(operations.findIndex((query) => query.includes("query ProductMedia(")));
      media.forEach((item) => { item.status = "READY"; });
      await syncKiotVietProductToShopify(1);
      expect(calls("CreateProduct")).toHaveLength(0);
      expect(calls("CreateProductMedia")).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ sync_status: "synced", last_sync_hash: expect.any(String) });
    } finally { vi.useRealTimers(); }
  });

  it("checkpoints a new product before media timeout and reuses it when READY without deletion or duplication", async () => {
    vi.useFakeTimers();
    try {
      pendingUpload = true;
      const sync = expect(syncKiotVietProductToShopify(1)).rejects.toThrow("still processing");
      await vi.runAllTimersAsync();
      await sync;
      expect(persisted[0]).toMatchObject({ shopify_product_id: "p1", shopify_variant_id: "v1", shopify_inventory_item_id: "i1", last_sync_hash: null, sync_status: "mapped" });
      expect(checkpoint).not.toBeNull();
      expect(calls("Cleanup")).toHaveLength(0);
      expect(storedVariant?.sku).toBe("A");
      expect(syncMocks.query).not.toHaveBeenCalled();
      expect(syncMocks.upsert.mock.invocationCallOrder[0]).toBeLessThan(
        graphql.mock.invocationCallOrder[graphql.mock.calls.findIndex(([query]) => query.includes("mutation CreateProductMedia("))],
      );
      media.forEach((item) => { item.status = "READY"; });
      // Even if Shopify's search index has not caught up, retry uses the ID.
      const implementation = graphql.getMockImplementation()!;
      graphql.mockImplementation(async (...args) => {
        if (args[0].includes("query BySku(")) throw new Error("Retry must not use search");
        return implementation(...args);
      });
      await expect(syncKiotVietProductToShopify(1)).resolves.toMatchObject({ updated: true });
      expect(calls("CreateProduct")).toHaveLength(1);
      expect(calls("CreateProductMedia")).toHaveLength(2);
      expect(calls("Cleanup")).toHaveLength(0);
      expect(persisted[0]).toMatchObject({ sync_status: "synced", last_sync_hash: expect.any(String) });
    } finally { vi.useRealTimers(); }
  });

  it("resumes a checkpointed blank-SKU product after a retryable setup failure", async () => {
    const implementation = graphql.getMockImplementation()!;
    graphql.mockImplementation(async (...args) => {
      if (args[0].includes("mutation UpdateProduct(")) throw new RetryableError("temporary update failure");
      return implementation(...args);
    });
    await expect(syncKiotVietProductToShopify(1)).rejects.toThrow("temporary update failure");
    expect(storedVariant?.sku).toBe("");
    expect(persisted[0].last_sync_hash).toBeNull();
    graphql.mockImplementation(implementation);
    await expect(syncKiotVietProductToShopify(1)).resolves.toMatchObject({ updated: true });
    expect(calls("CreateProduct")).toHaveLength(1);
    expect(calls("Cleanup")).toHaveLength(0);
  });

  it("retains a checkpointed product on permanent validation failure without recording success", async () => {
    const implementation = graphql.getMockImplementation()!;
    graphql.mockImplementation(async (...args) => {
      if (args[0].includes("mutation UpdateVariant("))
        return { productVariantsBulkUpdate: { productVariants: [], userErrors: [{ message: "Invalid barcode" }] } };
      return implementation(...args);
    });
    await expect(syncKiotVietProductToShopify(1)).rejects.toThrow("Invalid barcode");
    expect(persisted[0]).toMatchObject({ sync_status: "mapped", last_sync_hash: null });
    expect(calls("Cleanup")).toHaveLength(0);
    expect(calls("CreateProductMedia")).toHaveLength(0);
    graphql.mockImplementation(implementation);
    await syncKiotVietProductToShopify(1);
    expect(calls("CreateProduct")).toHaveLength(1);
  });

  it("propagates permanent creation rejection without starting updates or media", async () => {
    graphql.mockResolvedValueOnce({ productCreate: { product: null, userErrors: [{ message: "Invalid title" }] } });
    const checkpointProduct = vi.fn();
    await expect(createShopifyProduct(product, checkpointProduct)).rejects.toThrow("Invalid title");
    expect(checkpointProduct).not.toHaveBeenCalled();
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("cleans up an unusable creation with no default variant", async () => {
    graphql.mockResolvedValueOnce({ productCreate: { product: { id: "p1", variants: { nodes: [] } }, userErrors: [] } });
    await expect(createShopifyProduct(product, vi.fn())).rejects.toThrow("no usable default variant");
    expect(calls("Cleanup")).toHaveLength(1);
  });

  it("cleans up before media if the identity checkpoint cannot be persisted", async () => {
    syncMocks.upsert.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(syncKiotVietProductToShopify(1)).rejects.toThrow("database unavailable");
    expect(calls("Cleanup")).toHaveLength(1);
    expect(calls("CreateProductMedia")).toHaveLength(0);
    expect(persisted).toEqual([]);
  });

  it("reports cleanup failure together with the checkpoint failure", async () => {
    const implementation = graphql.getMockImplementation()!;
    graphql.mockImplementation(async (...args) => {
      if (args[0].includes("mutation Cleanup(")) return { productDelete: { deletedProductId: null, userErrors: [{ message: "delete denied" }] } };
      return implementation(...args);
    });
    await expect(createShopifyProduct(product, async () => { throw new Error("checkpoint failed"); }))
      .rejects.toMatchObject({ errors: [expect.objectContaining({ message: "checkpoint failed" }), expect.objectContaining({ message: "delete denied" })] });
  });

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
    await createShopifyProduct(product, async () => {});
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

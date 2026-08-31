import { beforeEach, describe, expect, it, vi } from "vitest";

const graphql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/shopify/graphql", () => ({ shopifyGraphql: graphql }));

import {
  createShopifyManualCollection,
  publishShopifyCollectionToOnlineStore,
  updateShopifyCollectionTitle,
} from "@/lib/shopify/collections";

describe("Shopify collection GraphQL", () => {
  beforeEach(() => graphql.mockReset());
  it("uses the 2026-07 collection inputs", async () => {
    graphql
      .mockResolvedValueOnce({
        collectionCreate: {
          collection: { id: "c1", title: "Shoes", handle: "shoes" },
          userErrors: [],
        },
      })
      .mockResolvedValueOnce({
        collectionUpdate: {
          collection: { id: "c1", title: "New Shoes", handle: "shoes" },
          userErrors: [],
        },
      });
    await createShopifyManualCollection("Shoes", "shoes");
    await updateShopifyCollectionTitle("c1", "New Shoes");
    expect(graphql.mock.calls[0][0]).toContain("CollectionCreateInput");
    expect(graphql.mock.calls[0][1]).toEqual({
      collection: { title: "Shoes", handle: "shoes" },
    });
    expect(graphql.mock.calls[1][0]).toContain("CollectionUpdateInput");
    expect(graphql.mock.calls[1][1]).toEqual({
      collection: { id: "c1", title: "New Shoes" },
    });
  });
  it("publishes the collection to Online Store", async () => {
    graphql
      .mockResolvedValueOnce({
        publications: { nodes: [{ id: "p1", name: "Online Store" }] },
      })
      .mockResolvedValueOnce({
        publishablePublish: {
          publishable: { publishedOnPublication: true },
          userErrors: [],
        },
      });
    await publishShopifyCollectionToOnlineStore("c1");
    expect(graphql.mock.calls[1][0]).toContain("publishablePublish");
    expect(graphql.mock.calls[1][1]).toEqual({
      collectionId: "c1",
      publicationId: "p1",
    });
  });
});

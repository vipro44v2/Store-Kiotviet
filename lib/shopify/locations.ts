import { shopifyGraphql } from "./graphql";import type { ShopifyLocation } from "@/types/shopify";
export async function getShopifyLocations(){const d=await shopifyGraphql<{locations:{nodes:ShopifyLocation[]}}>(`query Locations{locations(first:100){nodes{id name isActive}}}`);return d.locations.nodes;}

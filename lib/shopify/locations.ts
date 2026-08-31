import { shopifyGraphql } from "./graphql";import type { ShopifyLocation } from "@/types/shopify";
export async function getShopifyLocations(){const d=await shopifyGraphql<{locations:{nodes:ShopifyLocation[]}}>(`query Locations{locations(first:100){nodes{id name isActive}}}`);return d.locations.nodes;}

export async function getActiveShopifyLocations(): Promise<
  Array<Pick<ShopifyLocation, "id" | "name">>
> {
  const activeLocations: Array<Pick<ShopifyLocation, "id" | "name">> = [];
  let cursor: string | undefined;
  do {
    const data = await shopifyGraphql<{
      locations: {
        nodes: ShopifyLocation[];
        pageInfo: { hasNextPage: boolean; endCursor?: string };
      };
    }>(
      `query ActiveLocations($after:String){locations(first:100,after:$after){nodes{id name isActive} pageInfo{hasNextPage endCursor}}}`,
      { after: cursor },
    );
    activeLocations.push(
      ...data.locations.nodes
        .filter((location) => location.isActive)
        .map(({ id, name }) => ({ id, name })),
    );
    cursor = data.locations.pageInfo.hasNextPage
      ? data.locations.pageInfo.endCursor
      : undefined;
  } while (cursor);
  return activeLocations;
}

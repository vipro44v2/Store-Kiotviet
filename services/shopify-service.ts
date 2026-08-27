import { getShopifyLocations } from "@/lib/shopify/locations";import { getShopifyVariants } from "@/lib/shopify/products";import { shopifyGraphql } from "@/lib/shopify/graphql";
export const shopifyService={check:()=>shopifyGraphql<{shop:{id:string;name:string}}>(`query Connection{shop{id name}}`),locations:getShopifyLocations,variants:getShopifyVariants};

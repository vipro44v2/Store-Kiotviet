import { shopifyGraphql } from "./graphql";
export async function getShopifyFulfillment(id:string){const data=await shopifyGraphql<{fulfillment:{id:string;status:string;trackingInfo:Array<{company?:string;number?:string;url?:string}>}|null}>(`query Fulfillment($id:ID!){fulfillment(id:$id){id status trackingInfo{company number url}}}`,{id});return data.fulfillment;}

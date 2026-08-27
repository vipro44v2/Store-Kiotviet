import { shopifyGraphql } from "./graphql";
export interface ShopifyCustomerNode{id:string;displayName:string;firstName?:string;lastName?:string;email?:string;phone?:string;defaultAddress?:{address1?:string;city?:string;province?:string;zip?:string;country?:string}}
export async function getShopifyCustomer(id:string){const data=await shopifyGraphql<{customer:ShopifyCustomerNode|null}>(`query Customer($id:ID!){customer(id:$id){id displayName firstName lastName email phone defaultAddress{address1 city province zip country}}}`,{id});return data.customer;}

import { query } from "@/lib/db/client";
export const ordersRepository={findByShopifyId:async(id:string)=>(await query<Record<string,unknown>>("SELECT * FROM order_mappings WHERE shopify_order_id=$1",[id]))[0],list:(limit=200)=>query<Record<string,unknown>>("SELECT * FROM order_mappings ORDER BY created_at DESC LIMIT $1",[limit])};

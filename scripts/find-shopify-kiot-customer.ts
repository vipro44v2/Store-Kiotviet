import { kiotVietClient } from "../lib/kiotviet/client";
import { query } from "../lib/db/client";

async function main(){
  const mappings=await query<{shopify_customer_id:string;kiotviet_customer_id:string|null}>("SELECT shopify_customer_id,kiotviet_customer_id FROM customer_mappings ORDER BY updated_at DESC LIMIT 5");
  const page=await kiotVietClient.get<{data:Array<{id:number;code:string;comments?:string;createdDate?:string}>}>("/customers?pageSize=100&orderBy=createdDate&orderDirection=Desc");
  const ids=new Set(mappings.map((mapping)=>mapping.shopify_customer_id));
  const customers=page.data.filter((customer)=>[...ids].some((id)=>customer.comments?.includes(id))).map((customer)=>({id:customer.id,code:customer.code,comments:customer.comments,createdDate:customer.createdDate}));
  if(process.argv[2]==="repair")for(const mapping of mappings){const matches=customers.filter((customer)=>customer.comments?.includes(mapping.shopify_customer_id));if(!mapping.kiotviet_customer_id&&matches.length===1)await query("UPDATE customer_mappings SET kiotviet_customer_id=$2,updated_at=now() WHERE shopify_customer_id=$1",[mapping.shopify_customer_id,matches[0].id]);}
  console.log(JSON.stringify({mappings,customers},null,2));
}
main().then(()=>process.exit(0)).catch((error)=>{console.error(error);process.exit(1);});

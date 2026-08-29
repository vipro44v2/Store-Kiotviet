import { closeDatabase } from "@/lib/db/client";
import { closeRedis } from "@/lib/redis/client";
import { getShopifyRefundTransactions } from "@/lib/shopify/orders";
async function main(){process.stdout.write(`${JSON.stringify(await getShopifyRefundTransactions(process.argv[2],Number(process.argv[3])),null,2)}\n`);}
main().finally(async()=>{await closeRedis();await closeDatabase();});

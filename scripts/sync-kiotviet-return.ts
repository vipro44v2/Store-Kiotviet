import { closeDatabase } from "@/lib/db/client";
import { closeRedis } from "@/lib/redis/client";
import { syncKiotVietReturn } from "@/lib/sync/return-sync";

async function main(){const id=Number(process.argv[2]);if(!Number.isSafeInteger(id)||id<=0)throw new Error("Usage: sync-kiotviet-return.ts <return-id>");process.stdout.write(`${JSON.stringify(await syncKiotVietReturn(id),null,2)}\n`);}
main().finally(async()=>{await closeRedis();await closeDatabase();});

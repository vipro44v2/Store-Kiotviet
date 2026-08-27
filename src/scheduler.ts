import { assertProductionEnv,getEnv } from "../lib/env";import { getQueue,closeQueues } from "../lib/queue/queues";import { closeRedis } from "../lib/redis/client";
if(getEnv().NODE_ENV==="production")assertProductionEnv();
await getQueue("reconciliation").upsertJobScheduler("inventory-reconciliation",{every:60*60*1000},{name:"inventory_reconciliation",data:{},opts:{removeOnComplete:100}});
await getQueue("maintenance").upsertJobScheduler("cleanup-old-data",{pattern:"0 3 * * *"},{name:"cleanup_old_data",data:{},opts:{removeOnComplete:30}});
process.stdout.write(`${JSON.stringify({level:"info",message:"Schedulers registered"})}\n`);
async function shutdown(){await closeQueues();await closeRedis();process.exit(0);}process.on("SIGTERM",()=>void shutdown());process.on("SIGINT",()=>void shutdown());

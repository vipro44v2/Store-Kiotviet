import { query } from "../lib/db/client";

async function main(){
  const rows=await query<{value:Record<string,unknown>}>("SELECT value FROM system_settings WHERE key='orders'");
  const value={...(rows[0]?.value??{}),syncCustomers:true};
  await query("INSERT INTO system_settings(key,value,updated_at) VALUES('orders',$1,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[JSON.stringify(value)]);
  console.log(JSON.stringify(value));
}
main().then(()=>process.exit(0)).catch((error)=>{console.error(error);process.exit(1);});

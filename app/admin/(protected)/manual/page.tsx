import { connection } from "next/server";
import { ManualActions } from "@/components/admin/manual-actions";
import { DataTable } from "@/components/admin/data-table";
import { query } from "@/lib/db/client";
export default async function ManualPage(){await connection();let jobs:Record<string,unknown>[]=[];try{jobs=await query("SELECT id,type,status,attempts,error,created_at,completed_at FROM sync_jobs WHERE payload->>'manual'='true' ORDER BY created_at DESC LIMIT 30")}catch{}return <><header className="admin-header"><div><p className="eyebrow">Operations</p><h1>Manual operations</h1><p className="subtitle">Run individual synchronization workflows and monitor their queue results.</p></div></header><ManualActions/><section className="manual-history"><h2>Recent manual jobs</h2><DataTable rows={jobs} resource="jobs"/></section></>}

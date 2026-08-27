import { query } from "@/lib/db/client";
export const inventoryRepository={snapshots:(limit=200)=>query<Record<string,unknown>>("SELECT * FROM inventory_snapshots ORDER BY created_at DESC LIMIT $1",[limit]),branchMappings:()=>query<Record<string,unknown>>("SELECT * FROM branch_location_mappings ORDER BY kiotviet_branch_name")};

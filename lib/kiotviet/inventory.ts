import { kiotVietClient } from "./client";
interface InventoryResponse{total:number;pageSize:number;data:Array<{id:number;code:string;inventories:Array<{branchId:number;onHand:number;reserved:number}>}>}
export function getKiotVietInventory(currentItem=0,pageSize=100){return kiotVietClient.get<InventoryResponse>(`/productOnHands?${new URLSearchParams({currentItem:String(currentItem),pageSize:String(pageSize)})}`);}

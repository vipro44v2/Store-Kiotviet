import { kiotVietClient } from "./client";
export interface KiotVietOrderInput{branchId:number;purchaseDate:string;description:string;totalPayment:number;makeInvoice:boolean;customerId?:number;orderDetails:Array<{productId:number;quantity:number;price:number;discount?:number}>}
export function createKiotVietOrder(input:KiotVietOrderInput){return kiotVietClient.post<{id:number;code:string}>("/orders",input);}
export function cancelKiotVietOrder(id:number){return kiotVietClient.put<{message:string}>(`/orders/${id}`,{status:3});}

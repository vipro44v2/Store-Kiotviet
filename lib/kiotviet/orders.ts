import { kiotVietClient } from "./client";
export interface KiotVietOrderInput{branchId:number;purchaseDate?:string;description:string;discount:number;method:string;totalPayment:number;makeInvoice:boolean;customerId?:number;orderDetails:Array<{productId:number;productCode:string;productName:string;quantity:number;price:number;discount?:number}>}
export function createKiotVietOrder(input:KiotVietOrderInput){return kiotVietClient.post<{id:number;code:string}>("/orders",input);}
export async function cancelKiotVietOrder(id:number){const order=await kiotVietClient.get<{status:number}>(`/orders/${id}`);if(order.status===4)return{message:"Order is already cancelled"};return kiotVietClient.put<{message:string}>(`/orders/${id}`,{status:3});}

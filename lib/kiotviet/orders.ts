import { kiotVietClient } from "./client";
export interface KiotVietOrderInput{branchId:number;purchaseDate?:string;description:string;discount:number;method:string;totalPayment:number;makeInvoice:boolean;customer?:{id:number};orderDetails:Array<{productId:number;productCode:string;productName:string;quantity:number;price:number;discount?:number}>}
export function createKiotVietOrder(input:KiotVietOrderInput){return kiotVietClient.post<{id:number;code:string}>("/orders",input);}
export function updateKiotVietOrderCustomer(id:number,customerId:number){return kiotVietClient.put(`/orders/${id}`,{customer:{id:customerId}});}
export async function cancelKiotVietOrder(id:number){const order=await kiotVietClient.get<{status:number}>(`/orders/${id}`);if(order.status===4)return{message:"Order is already cancelled"};return kiotVietClient.delete<{message:string}>(`/orders/${id}?IsVoidPayment=true`);}

import { kiotVietClient } from "./client";
export interface KiotVietCustomerInput{name:string;contactNumber?:string;email?:string;address?:string;comments?:string}
export async function createKiotVietCustomer(input:KiotVietCustomerInput&{branchId:number}){const response=await kiotVietClient.post<{id?:number;Id?:number;code?:string;Code?:string;data?:{id?:number;Id?:number;code?:string;Code?:string}}>("/customers",input),value=response.data??response,id=Number(value.id??value.Id);if(!Number.isSafeInteger(id)||id<=0)throw new Error("KiotViet created the customer but did not return its ID");return{id,code:String(value.code??value.Code??"")};}
export function updateKiotVietCustomer(id:number,input:KiotVietCustomerInput){return kiotVietClient.put<{id:number;code:string}>(`/customers/${id}`,input);}
export interface KiotVietCustomerSummary{id:number;code?:string;name?:string|null;contactNumber?:string|null;email?:string|null}
/** Candidates only: KiotViet may match loosely, so callers must compare normalized phones themselves. */
export async function findKiotVietCustomersByPhone(contactNumber:string){const params=new URLSearchParams({contactNumber,pageSize:"100",currentItem:"0"});const result=await kiotVietClient.get<{data?:KiotVietCustomerSummary[]}>(`/customers?${params}`);return result.data??[];}

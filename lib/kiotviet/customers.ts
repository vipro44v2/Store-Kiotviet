import { kiotVietClient } from "./client";
export interface KiotVietCustomerInput{name:string;contactNumber?:string;email?:string;address?:string;comments?:string}
export function createKiotVietCustomer(input:KiotVietCustomerInput){return kiotVietClient.post<{id:number;code:string}>("/customers",input);}

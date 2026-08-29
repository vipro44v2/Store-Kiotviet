import { kiotVietClient } from "./client";
import type { KiotVietInvoice, KiotVietInvoicesResponse, KiotVietReturn, KiotVietReturnsResponse } from "./types";
export function getKiotVietReturns(lastModifiedFrom:string,currentItem=0,pageSize=100){const query=new URLSearchParams({lastModifiedFrom,currentItem:String(currentItem),pageSize:String(pageSize),orderBy:"modifiedDate",orderDirection:"Asc"});return kiotVietClient.get<KiotVietReturnsResponse>(`/returns?${query}`);}
export function getKiotVietReturn(id:number){return kiotVietClient.get<KiotVietReturn>(`/returns/${id}`);}
export function getKiotVietInvoice(id:number){return kiotVietClient.get<KiotVietInvoice>(`/invoices/${id}`);}
export function getKiotVietInvoices(lastModifiedFrom:string,currentItem=0,pageSize=100){const query=new URLSearchParams({lastModifiedFrom,currentItem:String(currentItem),pageSize:String(pageSize),orderBy:"modifiedDate",orderDirection:"Desc",includeDelivery:"true"});return kiotVietClient.get<KiotVietInvoicesResponse>(`/invoices?${query}`);}

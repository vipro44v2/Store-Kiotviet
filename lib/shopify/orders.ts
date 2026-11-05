import { shopifyGraphql } from "./graphql";
import { ConflictError, ValidationError } from "@/lib/errors";
export interface ShopifyOrderNode{id:string;name:string;createdAt:string;cancelledAt?:string;displayFinancialStatus:string;displayFulfillmentStatus:string;totalPriceSet:{shopMoney:{amount:string;currencyCode:string}};customer?:{id:string;displayName:string;email?:string;phone?:string};lineItems:{nodes:Array<{id:string;name:string;sku?:string;quantity:number;originalUnitPriceSet:{shopMoney:{amount:string}}}>}}
export async function getShopifyOrder(id:string){const data=await shopifyGraphql<{order:ShopifyOrderNode|null}>(`query Order($id:ID!){order(id:$id){id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus totalPriceSet{shopMoney{amount currencyCode}} customer{id displayName email phone} lineItems(first:250){nodes{id name sku quantity originalUnitPriceSet{shopMoney{amount}}}}}}`,{id});return data.order;}

export async function cancelShopifyOrderById(orderId: string, kiotVietOrderCode?: string) {
  const id = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
  const order = await getShopifyOrder(id);
  if (!order) throw new Error(`Shopify order ${orderId} was not found`);
  if (order.cancelledAt) return { alreadyCancelled: true };
  const result = await shopifyGraphql<{
    orderCancel: { orderCancelUserErrors: Array<{ message: string }>; userErrors: Array<{ message: string }>; job?: { id: string; done: boolean } };
  }>(
    `mutation CancelMappedOrder($orderId:ID!,$refundMethod:OrderCancelRefundMethodInput!,$restock:Boolean!,$reason:OrderCancelReason!,$staffNote:String){orderCancel(orderId:$orderId,refundMethod:$refundMethod,restock:$restock,reason:$reason,notifyCustomer:false,staffNote:$staffNote){job{id done} orderCancelUserErrors{message} userErrors{message}}}`,
    { orderId: id, refundMethod: { originalPaymentMethodsRefund: false }, restock: true, reason: "OTHER", staffNote: `Cancelled from KiotViet${kiotVietOrderCode ? ` (${kiotVietOrderCode})` : ""}` },
    // Never resent blindly: a job retry re-reads cancelledAt first.
    { nonIdempotent: true },
  );
  const errors = [...result.orderCancel.orderCancelUserErrors, ...result.orderCancel.userErrors];
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
  return result.orderCancel.job;
}

export interface TrackingInput { number:string;company?:string;url?:string }
async function updateFulfillmentTracking(fulfillmentId:string,tracking:TrackingInput){const result=await shopifyGraphql<{fulfillmentTrackingInfoUpdate:{fulfillment?:{id:string;status:string;trackingInfo:Array<{company?:string;number?:string;url?:string}>};userErrors:Array<{message:string}>}}>(`mutation UpdateTracking($fulfillmentId:ID!,$trackingInfoInput:FulfillmentTrackingInput!){fulfillmentTrackingInfoUpdate(fulfillmentId:$fulfillmentId,trackingInfoInput:$trackingInfoInput,notifyCustomer:false){fulfillment{id status trackingInfo{company number url}} userErrors{message}}}`,{fulfillmentId,trackingInfoInput:tracking});if(result.fulfillmentTrackingInfoUpdate.userErrors.length||!result.fulfillmentTrackingInfoUpdate.fulfillment)throw new Error(result.fulfillmentTrackingInfoUpdate.userErrors.map(error=>error.message).join("; ")||"Shopify did not update tracking");return result.fulfillmentTrackingInfoUpdate.fulfillment;}
export async function fulfillShopifyOrderById(orderId: string, kiotVietOrderCode?: string,tracking?:TrackingInput) {
  const id = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
  const data = await shopifyGraphql<{
    order: { cancelledAt?: string; displayFulfillmentStatus: string; fulfillmentOrders: { nodes: Array<{ id: string; status: string }> };fulfillments:Array<{id:string;status:string;trackingInfo:Array<{number?:string}>}> } | null;
  }>(
    `query FulfillmentOrders($id:ID!){order(id:$id){cancelledAt displayFulfillmentStatus fulfillmentOrders(first:50){nodes{id status}} fulfillments(first:50){id status trackingInfo{number}}}}`,
    { id },
  );
  if (!data.order) throw new Error(`Shopify order ${orderId} was not found`);
  if (data.order.cancelledAt) throw new Error(`Shopify order ${orderId} is already cancelled`);
  const open = data.order.fulfillmentOrders.nodes.filter((order) => ["OPEN", "IN_PROGRESS"].includes(order.status));
  if (!open.length){if(tracking){for(const fulfillment of data.order.fulfillments)await updateFulfillmentTracking(fulfillment.id,tracking);return{trackingUpdated:data.order.fulfillments.length};}return { alreadyFulfilled: data.order.displayFulfillmentStatus === "FULFILLED" };}
  for (const fulfillmentOrder of open) {
    const result = await shopifyGraphql<{
      fulfillmentCreate: { fulfillment?: { id: string; status: string }; userErrors: Array<{ message: string }> };
    }>(
      `mutation FulfillMappedOrder($fulfillment:FulfillmentInput!,$message:String){fulfillmentCreate(fulfillment:$fulfillment,message:$message){fulfillment{id status} userErrors{message}}}`,
      {
        fulfillment: { lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: fulfillmentOrder.id }], notifyCustomer: false,...(tracking?{trackingInfo:tracking}:{}) },
        message: `Completed from KiotViet${kiotVietOrderCode ? ` (${kiotVietOrderCode})` : ""}`,
      },
      // Never resent blindly: a job retry re-reads the open fulfillment orders first.
      { nonIdempotent: true },
    );
    if (result.fulfillmentCreate.userErrors.length || !result.fulfillmentCreate.fulfillment) {
      throw new Error(result.fulfillmentCreate.userErrors.map((error) => error.message).join("; ") || "Shopify did not create the fulfillment");
    }
  }
  return { fulfilled: open.length };
}

export interface ShopifyRefundLine { id:string;sku?:string;refundableQuantity:number }
export interface ShopifyExistingRefund { id:string;note?:string|null;createdAt?:string;totalRefundedSet?:{shopMoney:{amount:string}};refundLineItems:{nodes:Array<{quantity:number;lineItem:{id:string;sku?:string}}>} }
/** Note written on every refund this app creates for a KiotViet return; it identifies the refund later. */
export function kiotVietReturnRefundNote(returnCode:string){return `Returned and refunded from KiotViet (${returnCode}).`;}
/** Shopify executed refundCreate and rejected it (userErrors): definitely no refund was created. */
export class ShopifyRefundRejectedError extends ConflictError {}
/** The order has less refundable payment than requested; nothing is sent. */
export class InsufficientRefundableAmountError extends ValidationError {}
export interface ShopifyRefundTransaction { orderId:string;parentId:string;gateway:string;kind:"REFUND";amount:string }
export async function getShopifyRefundableLines(orderId:string){
  const id=orderId.startsWith("gid://")?orderId:`gid://shopify/Order/${orderId}`;
  const data=await shopifyGraphql<{order:{id:string;lineItems:{nodes:ShopifyRefundLine[]};refunds:ShopifyExistingRefund[]}|null}>(`query RefundableLines($id:ID!){order(id:$id){id lineItems(first:250){nodes{id sku refundableQuantity}} refunds{id note createdAt totalRefundedSet{shopMoney{amount}} refundLineItems(first:250){nodes{quantity lineItem{id sku}}}}}}`,{id});
  if(!data.order)throw new Error(`Shopify order ${orderId} was not found`);
  return data.order;
}
export async function getShopifyRefundTransactions(orderId:string,requestedAmount:number){
  const id=orderId.startsWith("gid://")?orderId:`gid://shopify/Order/${orderId}`;
  const data=await shopifyGraphql<{order:{transactions:Array<{id:string;kind:string;status:string;gateway:string;parentTransaction?:{id:string};amountSet:{shopMoney:{amount:string;currencyCode:string}}}>}|null}>(`query PaymentTransactions($id:ID!){order(id:$id){transactions{id kind status gateway parentTransaction{id} amountSet{shopMoney{amount currencyCode}}}}}`,{id});
  if(!data.order)throw new Error(`Shopify order ${orderId} was not found`);
  const successful=data.order.transactions.filter(transaction=>transaction.status==="SUCCESS");
  const sources=successful.filter(transaction=>transaction.kind==="SALE"||transaction.kind==="CAPTURE");
  const refunded=new Map<string,number>();
  for(const transaction of successful)if(transaction.kind==="REFUND"&&transaction.parentTransaction)refunded.set(transaction.parentTransaction.id,(refunded.get(transaction.parentTransaction.id)??0)+Number(transaction.amountSet.shopMoney.amount));
  // Integer cents; the full requested amount must be available (no silent under-refund).
  const cents=(value:number)=>Math.round(value*100);
  let remaining=cents(requestedAmount);const transactions:ShopifyRefundTransaction[]=[];
  for(const source of sources){const available=Math.max(0,cents(Number(source.amountSet.shopMoney.amount))-cents(refunded.get(source.id)??0)),amount=Math.min(available,remaining);if(amount>0){transactions.push({orderId:id,parentId:source.id,gateway:source.gateway,kind:"REFUND",amount:(amount/100).toFixed(2)});remaining-=amount;}if(remaining<=0)break;}
  if(remaining>0)throw new InsufficientRefundableAmountError(`Shopify has only ${((cents(requestedAmount)-remaining)/100).toFixed(2)} available to refund, but KiotViet requested ${requestedAmount.toFixed(2)}`);
  return transactions;
}
export async function createShopifyReturnRefund(orderId:string,lines:Array<{lineItemId:string;quantity:number}>,transactions:ShopifyRefundTransaction[],returnCode:string,idempotencyKey:string){
  const id=orderId.startsWith("gid://")?orderId:`gid://shopify/Order/${orderId}`;
  const data=await shopifyGraphql<{refundCreate:{refund?:{id:string;totalRefundedSet:{shopMoney:{amount:string;currencyCode:string}}};userErrors:Array<{field?:string[];message:string}>}}>(
    `mutation KiotVietReturn($input:RefundInput!,$idempotencyKey:String!){refundCreate(input:$input) @idempotent(key:$idempotencyKey){refund{id totalRefundedSet{shopMoney{amount currencyCode}}} userErrors{field message}}}`,
    {input:{orderId:id,notify:false,note:kiotVietReturnRefundNote(returnCode),...(lines.length?{refundLineItems:lines.map(line=>({...line,restockType:"NO_RESTOCK"}))}:{}),transactions},idempotencyKey},
    // A financial transaction: never resent here; an uncertain outcome is reconciled by the caller.
    {nonIdempotent:true},
  );
  if(data.refundCreate.userErrors.length)throw new ShopifyRefundRejectedError(data.refundCreate.userErrors.map(error=>error.message).join("; "));
  if(!data.refundCreate.refund)throw new ConflictError("Shopify refundCreate returned no refund and no error; outcome must be reconciled");
  return data.refundCreate.refund;
}
export interface ShopifyOrderPaymentState{updatedAt?:string;displayFulfillmentStatus?:string;createdAt?:string;cancelledAt:string|null;displayFinancialStatus:string;currencyCode:string;totalPriceSet:{shopMoney:{amount:string}};refunds:Array<{id:string}>}
/** Live payment state, used to reject stale stored webhook payloads before invoicing. */
export async function getShopifyOrderPaymentState(orderId:string){const data=await shopifyGraphql<{order:ShopifyOrderPaymentState|null}>(`query OrderPaymentState($id:ID!){order(id:$id){updatedAt createdAt displayFulfillmentStatus cancelledAt displayFinancialStatus currencyCode totalPriceSet{shopMoney{amount}} refunds{id}}}`,{id:`gid://shopify/Order/${orderId}`});return data.order;}

import {
  createKiotVietCustomer,
  findKiotVietCustomersByPhone,
  type KiotVietCustomerSummary,
} from "@/lib/kiotviet/customers";
import { ApiError, ConflictError } from "@/lib/errors";
import { query } from "@/lib/db/client";
import { log } from "@/lib/logger";
import { resolveDefaultBranchId } from "./default-branch";

interface ShopifyAddress{address1?:string|null;address2?:string|null;city?:string|null;province?:string|null;zip?:string|null;country?:string|null;phone?:string|null}
export interface ShopifyCustomerWebhook{id:number;first_name?:string|null;last_name?:string|null;email?:string|null;phone?:string|null;note?:string|null;default_address?:ShopifyAddress|null;addresses?:ShopifyAddress[]|null}
export function normalizePhone(value?:string|null){return (value??"").replace(/\D/g,"");}export function normalizeEmail(value?:string|null){return (value??"").trim().toLowerCase();}
/** Vietnamese numbers arrive as +84… from Shopify and 0… from KiotViet; compare them in one form. */
export function phoneKey(value?:string|null){const digits=normalizePhone(value);return digits.startsWith("84")&&digits.length>=11?`0${digits.slice(2)}`:digits;}
export function nameKey(value?:string|null){return (value??"").normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/đ/gi,"d").toLowerCase().replace(/\s+/g," ").trim();}

/** KiotViet rejects a new customer whose phone already belongs to a customer (HTTP 420). */
export function isDuplicatePhoneError(error:unknown){return error instanceof ApiError&&error.status===420&&/(phone|điện thoại)/i.test(error.message)&&/(exist|tồn tại)/i.test(error.message);}

/**
 * Reuses an existing KiotViet customer only when exactly one customer has the
 * same phone and the identity is confirmed by email (both present and equal),
 * or by full name when either side has no email. Anything else is manual
 * review: never a duplicate customer, never a merge of different people.
 * The KiotViet customer itself is never modified.
 */
async function reuseVerifiedKiotVietCustomer(customer:ShopifyCustomerWebhook,phone:string,email:string){
  const shopifyCustomerId=String(customer.id),ref=`Shopify customer ${shopifyCustomerId}`,key=phoneKey(phone);
  const found=new Map<number,KiotVietCustomerSummary>();
  for(const value of new Set([phone,key]))for(const candidate of await findKiotVietCustomersByPhone(value))if(phoneKey(candidate.contactNumber)===key)found.set(Number(candidate.id),candidate);
  const candidates=[...found.values()];
  if(candidates.length!==1)throw new ConflictError(`KiotViet reports that the phone of ${ref} already exists, but ${candidates.length} KiotViet customers match it; link the customer manually`,{shopifyCustomerId,mappingStatus:candidates.length?"ambiguous_customer":"customer_not_found"});
  const match=candidates[0],kiotVietEmail=normalizeEmail(match.email),personName=`${customer.first_name??""} ${customer.last_name??""}`.trim();
  let verifiedBy:"phone_and_email"|"phone_and_name";
  if(email&&kiotVietEmail){if(email!==kiotVietEmail)throw new ConflictError(`KiotViet customer ${match.id} has the phone of ${ref} but a different email; link the customer manually`,{shopifyCustomerId,kiotVietCustomerId:match.id,mappingStatus:"customer_identity_mismatch"});verifiedBy="phone_and_email";}
  else if(personName&&nameKey(personName)===nameKey(match.name))verifiedBy="phone_and_name";
  else throw new ConflictError(`KiotViet customer ${match.id} has the phone of ${ref}, but the identity cannot be confirmed by email or name; link the customer manually`,{shopifyCustomerId,kiotVietCustomerId:match.id,mappingStatus:"customer_identity_unverified"});
  const owner=await query<{shopify_customer_id:string}>("SELECT shopify_customer_id FROM customer_mappings WHERE kiotviet_customer_id=$1",[match.id]);
  if(owner[0]&&owner[0].shopify_customer_id!==shopifyCustomerId)throw new ConflictError(`KiotViet customer ${match.id} is already linked to Shopify customer ${owner[0].shopify_customer_id}; ${ref} needs manual review`,{shopifyCustomerId,kiotVietCustomerId:match.id,mappingStatus:"customer_linked_elsewhere"});
  await query("INSERT INTO customer_mappings(shopify_customer_id,kiotviet_customer_id,email,phone,last_sync_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(shopify_customer_id) DO NOTHING",[shopifyCustomerId,match.id,email||null,phone||null]);
  const linked=await query<{kiotviet_customer_id:string}>("SELECT kiotviet_customer_id FROM customer_mappings WHERE shopify_customer_id=$1",[shopifyCustomerId]);
  await log("info","Existing KiotViet customer linked after phone conflict",{action:"customer_reused_after_phone_conflict",provider:"kiotviet",entityType:"customer",entityId:shopifyCustomerId,kiotVietCustomerId:match.id,verifiedBy});
  return{created:false,reused:true,kiotvietCustomerId:String(linked[0]?.kiotviet_customer_id??match.id)};
}

export async function syncShopifyCustomer(customer:ShopifyCustomerWebhook,defaultBranchId?:number){
  const phone=normalizePhone(customer.phone??customer.default_address?.phone),email=normalizeEmail(customer.email);
  const address=customer.default_address??customer.addresses?.[0];
  const input={name:`${customer.first_name??""} ${customer.last_name??""}`.trim()||email||phone||`Shopify ${customer.id}`,contactNumber:phone||undefined,email:email||undefined,address:[address?.address1,address?.address2,address?.city,address?.province,address?.zip,address?.country].filter(Boolean).join(", "),comments:customer.note||`Đồng bộ từ Shopify #${customer.id}`};
  const existing=await query<{kiotviet_customer_id:string}>("SELECT kiotviet_customer_id FROM customer_mappings WHERE shopify_customer_id=$1",[String(customer.id)]);
  if(existing.length){/* Keep KiotViet as the source of truth for existing customers; staff edits must not be overwritten. */await query("UPDATE customer_mappings SET email=$2,phone=$3,last_sync_at=now(),updated_at=now() WHERE shopify_customer_id=$1",[String(customer.id),email||null,phone||null]);return{created:false,kiotvietCustomerId:existing[0].kiotviet_customer_id};}
  const matches=await query<{id:string}>("SELECT id FROM customer_mappings WHERE ($1<>'' AND phone=$1) OR ($2<>'' AND lower(email)=$2)",[phone,email]);
  if(matches.length>1)throw new ConflictError(`Ambiguous customer match for Shopify customer ${customer.id}`);
  const branchId=defaultBranchId??await resolveDefaultBranchId();
  let created:{id:number;code:string};
  try{created=await createKiotVietCustomer({...input,branchId});}
  catch(error){if(phone&&isDuplicatePhoneError(error))return reuseVerifiedKiotVietCustomer(customer,phone,email);throw error;}
  await query("INSERT INTO customer_mappings(shopify_customer_id,kiotviet_customer_id,email,phone,last_sync_at) VALUES($1,$2,$3,$4,now())",[String(customer.id),created.id,email||null,phone||null]);
  return{created:true,kiotvietCustomerId:String(created.id)};
}

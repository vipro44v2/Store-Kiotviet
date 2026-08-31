import { describe,expect,it } from "vitest";
import { shouldSkipUnchangedProduct } from "@/lib/sync/kiotviet-product-sync";
import { matchKiotVietOrderByShopifyReference } from "@/lib/kiotviet/orders";

describe("order recovery",()=>{
  it("finds the KiotViet order using the exact Shopify ID reference",()=>{
    const orders=[{id:1,code:"DH1",description:"Shopify #10 (10)"},{id:2,code:"DH2",description:"Shopify #100 (100)"}];
    expect(matchKiotVietOrderByShopifyReference(orders,"10")?.id).toBe(1);
  });
});

describe("archived product recovery",()=>{
  it("does not skip an archived single product with an unchanged hash",()=>{
    expect(shouldSkipUnchangedProduct("same",[{last_sync_hash:"same",sync_status:"archived"}])).toBe(false);
  });
  it("does not skip a variant family when any related mapping is archived",()=>{
    expect(shouldSkipUnchangedProduct("same",[{last_sync_hash:"same",sync_status:"synced"}],[{last_sync_hash:"same",sync_status:"synced"},{last_sync_hash:"same",sync_status:"archived"}])).toBe(false);
  });
});

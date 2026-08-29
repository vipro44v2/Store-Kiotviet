import { describe,expect,it } from "vitest";
import { findExistingRefund,matchReturnLines } from "@/lib/sync/return-sync";

describe("return mapping",()=>{
  it("maps a KiotViet SKU to its refundable Shopify line",()=>{
    expect(matchReturnLines([{productId:1,productCode:" sku-1 ",productName:"P",quantity:1,price:100}],[{id:"line-1",sku:"SKU-1",refundableQuantity:2}])).toEqual([{lineItemId:"line-1",quantity:1}]);
  });
  it("rejects a quantity exceeding the refundable quantity",()=>{
    expect(()=>matchReturnLines([{productId:1,productCode:"SKU-1",productName:"P",quantity:2,price:100}],[{id:"line-1",sku:"SKU-1",refundableQuantity:1}])).toThrow(/exceeds/);
  });
  it("detects a matching refund that Shopify already has",()=>{
    expect(findExistingRefund([{productId:1,productCode:"SKU-1",productName:"P",quantity:1,price:100}],[{id:"refund-1",refundLineItems:{nodes:[{quantity:1,lineItem:{sku:"sku-1"}}]}}])?.id).toBe("refund-1");
  });
});

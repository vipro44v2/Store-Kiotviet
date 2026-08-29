export interface KiotVietInventory {
  branchId: number;
  branchName: string;
  onHand: number;
  reserved?: number;
  actualReserved?: number;
  minQuantity?: number;
  maxQuantity?: number;
}

export interface KiotVietProduct {
  id: number;
  code: string;
  name: string;
  fullName?: string;
  categoryId?: number;
  categoryName?: string;
  allowsSale?: boolean;
  basePrice?: number;
  hasVariants?: boolean;
  masterProductId?: number;
  attributes?: Array<{ productId?: number; attributeName: string; attributeValue: string }>;
  weight?: number;
  unit?: string;
  description?: string;
  isActive?: boolean;
  images?: string[];
  inventories?: KiotVietInventory[];
  barCode?: string;
  modifiedDate?: string;
}

export interface KiotVietBranch { id: number; branchName: string; isActive?: boolean }
export interface KiotVietStockNotification { ProductId:number;ProductCode:string;ProductName:string;BranchId:number;BranchName:string;Cost:number;OnHand:number;Reserved:number }
export interface KiotVietWebhookPayload { Id:string;Attempt:number;RemoveId?:number[];removeId?:number[];Notifications:Array<{Action:string;Data:Array<KiotVietStockNotification|Record<string,unknown>>;RemoveId?:number[];removeId?:number[]}> }

export interface KiotVietProductsResponse {
  total: number;
  pageSize: number;
  data: KiotVietProduct[];
}

export interface GetProductsParams {
  pageSize?: number;
  currentItem?: number;
  orderBy?: string;
  orderDirection?: "Asc" | "Desc";
  includeInventory?: boolean;
  searchTerm?: string;
}

export interface KiotVietReturnDetail { productId:number;productCode:string;productName:string;quantity:number;price:number;subTotal?:number }
export interface KiotVietReturn { id:number;code:string;invoiceId?:number;returnDate:string;returnTotal:number;totalPayment:number;status:number;statusValue:string;modifiedDate?:string;returnDetails:KiotVietReturnDetail[] }
export interface KiotVietReturnsResponse { total:number;pageSize:number;data:KiotVietReturn[] }
export interface KiotVietInvoice { id:number;code:string;orderCode?:string;status:number;statusValue:string;modifiedDate?:string;invoiceDelivery?:{deliveryCode?:string;status?:number;statusValue?:string;partnerDelivery?:{name?:string}} }
export interface KiotVietInvoicesResponse { total:number;pageSize:number;data:KiotVietInvoice[] }

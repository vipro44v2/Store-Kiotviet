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
export interface KiotVietWebhookPayload { Id:string;Attempt:number;Notifications:Array<{Action:string;Data:KiotVietStockNotification[]}> }

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

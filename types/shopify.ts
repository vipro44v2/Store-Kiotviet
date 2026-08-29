export interface ShopifyGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}
export interface ShopifyVariant {
  id: string;
  sku: string;
  barcode?: string;
  product: { id: string; title: string };
  inventoryItem: { id: string; tracked: boolean };
}
export interface ShopifyLocation {
  id: string;
  name: string;
  isActive: boolean;
}
export interface ShopifyOrderWebhook {
  id: number;
  name: string;
  created_at: string;
  cancelled_at?: string;
  financial_status: string;
  fulfillment_status?: string;
  total_price: string;
  email?: string;
  phone?: string;
  customer?: {
    id: number;
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    addresses?: Array<{
      address1?: string;
      city?: string;
      province?: string;
      zip?: string;
      country?: string;
    }>;
  };
  line_items: Array<{
    id: number;
    sku: string;
    quantity: number;
    price: string;
    name: string;
  }>;
}

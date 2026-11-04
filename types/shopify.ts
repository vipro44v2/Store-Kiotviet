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
  /** Admin GraphQL `ProductVariant.sku` is nullable. */
  sku: string | null;
  barcode?: string | null;
  product: { id: string; title: string };
  inventoryItem: { id: string; tracked: boolean };
}
export interface ShopifyLocation {
  id: string;
  name: string;
  isActive: boolean;
}
export interface ShopifyWebhookAddress {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  country?: string | null;
  phone?: string | null;
}
/**
 * Shopify REST order webhook payload. Shopify sends `null` (not an absent key)
 * for many fields: guest checkouts have `customer: null`, custom/deleted items
 * have `sku: null` or `""`, and unfulfilled orders have `fulfillment_status: null`.
 */
export interface ShopifyOrderWebhookCustomer {
  id?: number | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  note?: string | null;
  default_address?: ShopifyWebhookAddress | null;
  addresses?: ShopifyWebhookAddress[] | null;
}
export interface ShopifyOrderLineItem {
  id: number;
  sku?: string | null;
  quantity: number;
  price: string;
  name?: string | null;
  title?: string | null;
  variant_id?: number | null;
  product_id?: number | null;
}
export interface ShopifyOrderWebhook {
  id: number;
  name: string;
  created_at?: string | null;
  cancelled_at?: string | null;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  total_price: string;
  email?: string | null;
  phone?: string | null;
  customer?: ShopifyOrderWebhookCustomer | null;
  line_items: ShopifyOrderLineItem[];
}

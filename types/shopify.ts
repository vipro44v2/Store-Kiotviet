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
export interface ShopifyTaxLine {
  price?: string | null;
}
export interface ShopifyOrderLineItem {
  id: number;
  sku?: string | null;
  quantity: number;
  /** Unit price before discounts. */
  price: string;
  name?: string | null;
  title?: string | null;
  variant_id?: number | null;
  product_id?: number | null;
  /** Deprecated by Shopify in favor of discount_allocations; used only as a fallback. */
  total_discount?: string | null;
  discount_allocations?: Array<{ amount?: string | null }> | null;
  tax_lines?: ShopifyTaxLine[] | null;
}
export interface ShopifyShippingLine {
  price?: string | null;
  discounted_price?: string | null;
  tax_lines?: ShopifyTaxLine[] | null;
}
export interface ShopifyRefund {
  id: number;
  refund_line_items?: Array<{ line_item_id: number; quantity: number }> | null;
  transactions?: Array<{ kind?: string | null; status?: string | null; amount?: string | null }> | null;
}
export interface ShopifyOrderWebhook {
  id: number;
  name: string;
  created_at?: string | null;
  cancelled_at?: string | null;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  total_price: string;
  /** Shop currency of all amounts in this payload. */
  currency?: string | null;
  refunds?: ShopifyRefund[] | null;
  taxes_included?: boolean | null;
  total_tip_received?: string | null;
  shipping_lines?: ShopifyShippingLine[] | null;
  email?: string | null;
  phone?: string | null;
  customer?: ShopifyOrderWebhookCustomer | null;
  line_items: ShopifyOrderLineItem[];
}

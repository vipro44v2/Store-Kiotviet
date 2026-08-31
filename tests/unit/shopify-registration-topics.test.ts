import { describe, expect, it } from "vitest";
import { SHOPIFY_REGISTRATION_TOPICS } from "@/lib/shopify/registration-topics";

describe("Shopify production webhook registration", () => {
  it("does not register unsupported manual-review topics", () => {
    expect(Object.keys(SHOPIFY_REGISTRATION_TOPICS)).not.toEqual(
      expect.arrayContaining([
        "products/create",
        "products/update",
        "products/delete",
        "refunds/create",
        "fulfillments/create",
        "fulfillments/update",
      ]),
    );
    expect(Object.keys(SHOPIFY_REGISTRATION_TOPICS)).toEqual([
      "orders/create",
      "orders/updated",
      "orders/cancelled",
      "customers/create",
      "customers/update",
      "inventory_levels/update",
      "app/uninstalled",
    ]);
  });
});

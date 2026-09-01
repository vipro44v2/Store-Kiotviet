import { describe, expect, it } from "vitest";
import { getEnv, resetEnvForTests } from "@/lib/env";
import { validateStoreConfig } from "@/lib/store-config";

describe("store configuration", () => {
  it("reports missing portable store settings", () => {
    resetEnvForTests();
    const errors = validateStoreConfig(getEnv());
    expect(errors).toEqual(expect.arrayContaining(["PUBLIC_APP_URL is required", "SHOPIFY_SHOP is required", "KIOTVIET_RETAILER is required"]));
  });
});

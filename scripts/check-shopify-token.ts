import { shopifyGraphql } from "../lib/shopify/graphql";

async function main() {
  const data = await shopifyGraphql<{
    shop: { name: string; myshopifyDomain: string };
    currentAppInstallation: { accessScopes: Array<{ handle: string }> };
  }>(`query TokenCheck { shop { name myshopifyDomain } currentAppInstallation { accessScopes { handle } } }`);

  const scopes = data.currentAppInstallation.accessScopes.map((scope) => scope.handle).sort();
  console.log(JSON.stringify({ shop: data.shop, scopes }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

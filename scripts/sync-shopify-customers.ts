import { shopifyGraphql } from "../lib/shopify/graphql";
import { syncShopifyCustomer } from "../lib/sync/customer-sync";

type CustomerNode = {
  id: string;
  legacyResourceId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  note?: string;
  defaultAddress?: { address1?: string; address2?: string; city?: string; province?: string; zip?: string; country?: string; phone?: string };
};

async function main() {
  let after: string | null = null;
  let created = 0;
  let updated = 0;
  const failed: Array<{ shopifyCustomerId: string; error: string }> = [];
  do {
    const data: { customers: { nodes: CustomerNode[]; pageInfo: { hasNextPage: boolean; endCursor?: string } } } = await shopifyGraphql(
      `query CustomerBackfill($after:String){customers(first:100,after:$after){nodes{id legacyResourceId firstName lastName email phone note defaultAddress{address1 address2 city province zip country phone}} pageInfo{hasNextPage endCursor}}}`,
      { after },
    );
    for (const customer of data.customers.nodes) {
      try {
        const result = await syncShopifyCustomer({
          id: Number(customer.legacyResourceId),
          first_name: customer.firstName,
          last_name: customer.lastName,
          email: customer.email,
          phone: customer.phone,
          note: customer.note,
          default_address: customer.defaultAddress,
        });
        if (result.created) created += 1; else updated += 1;
      } catch (error) {
        failed.push({ shopifyCustomerId: customer.legacyResourceId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    after = data.customers.pageInfo.hasNextPage ? data.customers.pageInfo.endCursor ?? null : null;
  } while (after);
  console.log(JSON.stringify({ created, updated, failed, total: created + updated + failed.length }));
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });

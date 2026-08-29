import { getKiotVietProducts } from "../lib/kiotviet/products";

async function main() {
  const page = await getKiotVietProducts({ pageSize: 100, includeInventory: false });
  const products = page.data as unknown as Array<Record<string, unknown>>;
  const candidates = products
    .filter((product) => product.hasVariants || product.masterProductId || Array.isArray(product.attributes))
    .map((product) => ({ id: product.id, code: product.code, name: product.name, fullName: product.fullName, isActive: product.isActive, hasVariants: product.hasVariants, masterProductId: product.masterProductId, attributes: product.attributes }));
  console.log(JSON.stringify({ total: page.total, candidates }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

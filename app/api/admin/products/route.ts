import { z } from "zod";
import { getAdminProductCatalogPage, PRODUCT_PAGE_SIZES } from "@/lib/admin/product-catalog";
import { adminApiErrorResponse, requireAdmin } from "@/lib/auth/middleware";

const schema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().refine(
    (value) => PRODUCT_PAGE_SIZES.includes(value as (typeof PRODUCT_PAGE_SIZES)[number]),
    "Invalid page size",
  ).default(40),
  search: z.string().trim().max(100).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
});

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const input = schema.parse(Object.fromEntries(url.searchParams));
    return Response.json({
      success: true,
      ...(await getAdminProductCatalogPage({
        page: input.page,
        pageSize: input.pageSize as (typeof PRODUCT_PAGE_SIZES)[number],
        search: input.search,
        categoryId: input.categoryId,
      })),
    });
  } catch (error) {
    return adminApiErrorResponse(error, "Could not load KiotViet products", 502);
  }
}


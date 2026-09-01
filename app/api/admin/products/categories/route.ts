import { adminApiErrorResponse, requireAdmin } from "@/lib/auth/middleware";
import { getAllKiotVietCategories } from "@/lib/kiotviet/products";

export async function GET() {
  try {
    await requireAdmin();
    const categories = await getAllKiotVietCategories();
    return Response.json({
      success: true,
      categories: categories.map((category) => ({
        id: category.id ?? category.categoryId,
        name: category.name ?? category.categoryName ?? `Category ${category.id}`,
      })).filter((category) => Number.isSafeInteger(category.id) && Number(category.id) > 0),
    });
  } catch (error) {
    return adminApiErrorResponse(error, "Could not load KiotViet categories", 502);
  }
}

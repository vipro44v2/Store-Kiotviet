import { NextRequest, NextResponse } from "next/server";
import { getKiotVietProducts } from "@/lib/kiotviet/products";
import type { GetProductsParams } from "@/lib/kiotviet/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function boundedInteger(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const direction = searchParams.get("orderDirection");
  const params: GetProductsParams = {
    pageSize: boundedInteger(searchParams.get("pageSize"), 20, 1, 100),
    currentItem: boundedInteger(searchParams.get("currentItem"), 0, 0, Number.MAX_SAFE_INTEGER),
    includeInventory: searchParams.get("includeInventory") !== "false",
    orderBy: searchParams.get("orderBy") || undefined,
    orderDirection: direction === "Asc" || direction === "Desc" ? direction : undefined,
    searchTerm: searchParams.get("searchTerm") || undefined,
  };

  try {
    const result = await getKiotVietProducts(params);
    return NextResponse.json({ success: true, total: result.total, data: result.data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected KiotViet error";
    console.error("GET /api/kiotviet/products failed", { message });
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

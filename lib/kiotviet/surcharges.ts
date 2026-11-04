import { kiotVietClient } from "./client";

/** GET /surchages ("thu khác"; the API spells it without the second r). */
export interface KiotVietSurcharge {
  id: number;
  surchargeCode: string;
  surchargeName?: string;
  value?: number | null;
  valueRatio?: number | null;
}

export async function listKiotVietSurcharges() {
  const surcharges: KiotVietSurcharge[] = [];
  let currentItem = 0, total = 1;
  while (currentItem < total) {
    const page = await kiotVietClient.get<{ total?: number; pageSize?: number; data?: KiotVietSurcharge[] }>(
      `/surchages?${new URLSearchParams({ pageSize: "100", currentItem: String(currentItem) })}`,
    );
    surcharges.push(...(page.data ?? []));
    total = Number(page.total ?? 0);
    currentItem += Number(page.pageSize) || 100;
    if (!page.data?.length) break;
  }
  return surcharges;
}

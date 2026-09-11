/** Normalize legacy stored data. API writes still require strict validation. */
export function parseDraftCategoryIds(value: unknown): number[] {
  if (typeof value !== "object" || value === null || !("categoryIds" in value) ||
    !Array.isArray(value.categoryIds)) return [];
  return [...new Set(value.categoryIds.filter((id): id is number =>
    typeof id === "number" && Number.isSafeInteger(id) && id > 0,
  ))].sort((a, b) => a - b);
}

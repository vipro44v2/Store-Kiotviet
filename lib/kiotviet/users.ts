import { getEnv } from "@/lib/env";
import { ConflictError } from "@/lib/errors";
import { getActiveKiotVietBranches } from "./branches";
import { kiotVietClient } from "./client";

/** GET /users item. Only fields present in the response are trusted. */
export interface KiotVietUser {
  id: number;
  userName?: string | null;
  givenName?: string | null;
  isActive?: boolean | null;
  branchIds?: number[] | null;
}

const MAX_PAGES = 50;

/**
 * All KiotViet users, read page by page. Deleted users are not returned, so a
 * seller missing here is rejected by POST /orders and POST /invoices (HTTP 420
 * "Người bán không tồn tại hoặc đã bị xóa khỏi hệ thống").
 */
export async function listKiotVietUsers(): Promise<KiotVietUser[]> {
  const users: KiotVietUser[] = [];
  let currentItem = 0, total = 1;
  for (let page = 0; page < MAX_PAGES && currentItem < total; page++) {
    const result = await kiotVietClient.get<{ total?: number; pageSize?: number; data?: KiotVietUser[] }>(
      `/users?${new URLSearchParams({ pageSize: "100", currentItem: String(currentItem) })}`,
    );
    total = Number(result.total ?? 0);
    // Advance by what was actually returned; an empty page is never progress.
    if (!result.data?.length) break;
    users.push(...result.data);
    currentItem += result.data.length;
  }
  if (currentItem < total) throw new Error("KiotViet user list is incomplete; cannot verify the seller");
  return users;
}

/**
 * The verified seller. `soldById` stays server-side: it is sent to KiotViet
 * but never returned to the browser, written to logs or shown in messages.
 */
export interface VerifiedSeller {
  soldById: number;
  source: "order" | "default";
}
export interface SellerResolution {
  seller: VerifiedSeller | null;
  /** Why candidates were rejected, without any user ID. */
  rejected: string[];
}

const DEFAULT_LABEL = "default seller (KIOTVIET_DEFAULT_SOLD_BY_ID)";

/** Server-side only. Missing or malformed values are reported, never thrown at startup. */
export function defaultSellerId(): { id: number | null; problem: string | null } {
  const raw = String(getEnv().KIOTVIET_DEFAULT_SOLD_BY_ID ?? "").trim();
  if (!raw) return { id: null, problem: `${DEFAULT_LABEL} is not configured` };
  if (!/^[1-9]\d{0,17}$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    return { id: null, problem: `${DEFAULT_LABEL} is not a positive integer` };
  return { id: Number(raw), problem: null };
}

async function activeBranchCount() {
  return (await getActiveKiotVietBranches()).length;
}

/**
 * Why a user cannot sell at `branchId`, or null when verified.
 * - must exist (deleted users are absent) and must not be isActive=false;
 * - branch membership is checked when KiotViet returns branchIds;
 * - a fallback seller whose branch cannot be proven is refused when the
 *   retailer has several active branches (never borrow another branch's staff).
 */
function invalidReason(user: KiotVietUser | undefined, branchId: number, options: { requireBranchProof: boolean; branches: number }) {
  if (!user) return "does not exist or was deleted";
  if (user.isActive === false) return "is inactive";
  const branchIds = Array.isArray(user.branchIds) ? user.branchIds.map(Number) : null;
  if (branchIds?.length && !branchIds.includes(Number(branchId))) return "does not belong to the order's branch";
  if (!branchIds?.length && options.requireBranchProof && options.branches > 1)
    return `cannot be verified for the order's branch (KiotViet returns no branch membership and ${options.branches} branches are active)`;
  return null;
}

/**
 * Invoice seller: the KiotViet order's own seller when still valid, otherwise
 * the verified KIOTVIET_DEFAULT_SOLD_BY_ID. The env value is only required when
 * the order's seller is invalid.
 */
export async function resolveInvoiceSeller(order: { soldById?: number | null; branchId: number }): Promise<SellerResolution> {
  const users = await listKiotVietUsers();
  const rejected: string[] = [];
  const orderSeller = Number(order.soldById);
  if (Number.isSafeInteger(orderSeller) && orderSeller > 0) {
    // KiotViet assigned this seller to the order at its branch; branch proof is not required.
    const reason = invalidReason(users.find((user) => Number(user.id) === orderSeller), order.branchId, { requireBranchProof: false, branches: 1 });
    if (!reason) return { seller: { soldById: orderSeller, source: "order" }, rejected };
    rejected.push(`order seller ${reason}`);
  } else rejected.push("the KiotViet order has no seller");

  const fallback = defaultSellerId();
  if (fallback.problem) return { seller: null, rejected: [...rejected, fallback.problem] };
  if (fallback.id === orderSeller) return { seller: null, rejected: [...rejected, `${DEFAULT_LABEL} is the same invalid seller`] };
  const reason = invalidReason(users.find((user) => Number(user.id) === fallback.id), order.branchId, { requireBranchProof: true, branches: await activeBranchCount() });
  if (reason) return { seller: null, rejected: [...rejected, `${DEFAULT_LABEL} ${reason}`] };
  return { seller: { soldById: fallback.id!, source: "default" }, rejected };
}

/** Seller for a new KiotViet order created from Shopify: the verified default seller. */
export async function resolveNewOrderSeller(branchId: number): Promise<VerifiedSeller> {
  const fallback = defaultSellerId();
  if (fallback.problem)
    throw new ConflictError(`seller_invalid: ${fallback.problem}; the KiotViet order was not created`, { mappingStatus: "seller_invalid" });
  const users = await listKiotVietUsers();
  const reason = invalidReason(users.find((user) => Number(user.id) === fallback.id), branchId, { requireBranchProof: true, branches: await activeBranchCount() });
  if (reason)
    throw new ConflictError(`seller_invalid: ${DEFAULT_LABEL} ${reason}; the KiotViet order was not created`, { mappingStatus: "seller_invalid" });
  return { soldById: fallback.id!, source: "default" };
}

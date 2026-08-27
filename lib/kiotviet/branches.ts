import { kiotVietClient } from "./client";import type { KiotVietBranch } from "./types";
export async function getKiotVietBranches(){const r=await kiotVietClient.get<{data:KiotVietBranch[]}|KiotVietBranch[]>("/branches");return Array.isArray(r)?r:r.data;}

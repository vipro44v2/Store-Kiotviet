import { getKiotVietAccessToken } from "@/lib/kiotviet/auth";import { getKiotVietBranches } from "@/lib/kiotviet/branches";import { getKiotVietProducts } from "@/lib/kiotviet/products";
export const kiotVietService={check:()=>getKiotVietAccessToken(true),branches:getKiotVietBranches,products:getKiotVietProducts};

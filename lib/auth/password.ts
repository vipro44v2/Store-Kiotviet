import { timingSafeEqual } from "node:crypto";
export function verifyCredential(actual: string, expected: string): boolean { const a=Buffer.from(actual); const b=Buffer.from(expected); return a.length === b.length && timingSafeEqual(a,b); }

import { createHash } from "node:crypto";
function stable(value:unknown):unknown{if(Array.isArray(value))return value.map(stable);if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)]));return value;}
export function syncHash(value:unknown):string{return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");}
export function isSyncLoop(lastHash:string|null,value:unknown):boolean{return !!lastHash&&lastHash===syncHash(value);}

import { defineConfig } from "vitest/config";import { fileURLToPath } from "node:url";
export default defineConfig({test:{environment:"node",setupFiles:["./tests/setup/no-network.ts"],coverage:{reporter:["text"]}},resolve:{alias:{"@":fileURLToPath(new URL(".",import.meta.url))}}});

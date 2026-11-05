/**
 * Tests must never reach a real provider (in particular KiotViet POST /invoices
 * or /orders). Any fetch that a test did not stub fails loudly instead.
 * Tests that stub fetch (vi.stubGlobal / vi.spyOn) replace this guard as before.
 */
const guarded: typeof fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`Network access is disabled in tests (attempted ${url}); mock the provider client instead`);
};
globalThis.fetch = guarded;
// No real waiting between the post-timeout invoice searches (two immediate searches).
process.env.INVOICE_UNCERTAIN_POLL_MS ??= "0,0";

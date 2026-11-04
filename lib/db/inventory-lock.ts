import { getPool } from "./client";
import { RetryableError } from "@/lib/errors";

/** Session lock, not a transaction. Never wait while occupying the pool. */
export async function withInventoryLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  let locked = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [key]);
    locked = result.rows[0]?.locked === true;
    if (!locked) throw new RetryableError("Inventory synchronization already running for this branch/product");
    return await work();
  } finally {
    // Destroy the connection if unlocking fails; never return a locked session to the pool.
    let broken = false;
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]); }
      catch { broken = true; }
    }
    client.release(broken);
  }
}

import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { getEnv } from "@/lib/env";

const globalDb = globalThis as typeof globalThis & {
  __shopifyKiotVietPool?: Pool;
};

export function getPool(): Pool {
  if (globalDb.__shopifyKiotVietPool) return globalDb.__shopifyKiotVietPool;
  const env = getEnv();
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    min: env.DATABASE_POOL_MIN,
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "shopify-kiotviet-sync",
  });
  pool.on("error", (error) =>
    process.stderr.write(
      `${JSON.stringify({ level: "error", message: "PostgreSQL pool error", error: error.message })}\n`,
    ),
  );
  globalDb.__shopifyKiotVietPool = pool;
  return pool;
}

export async function query<T extends QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  return (await getPool().query<T>(text, [...values])).rows;
}

export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabase(): Promise<void> {
  if (globalDb.__shopifyKiotVietPool) {
    await globalDb.__shopifyKiotVietPool.end();
    delete globalDb.__shopifyKiotVietPool;
  }
}

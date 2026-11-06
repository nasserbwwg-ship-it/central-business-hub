import "dotenv/config";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { ApiError } from "./errors.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required. Copy apps/api/.env.example to apps/api/.env and configure PostgreSQL.");
}

export const pool = new Pool({
  connectionString,
  max: Number(process.env.DB_POOL_SIZE ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,
  application_name: "central-business-hub",
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
});

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, [...values]);
}

export async function audit(
  client: PoolClient,
  companyId: string,
  actorId: string,
  eventType: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (company_id, actor_user_id, event_type, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [companyId, actorId, eventType, entityType, entityId, details],
  );
}

export async function ensureCompanyActive(companyId: string): Promise<void> {
  const result = await query<{ status: string }>("SELECT status FROM companies WHERE id = $1", [companyId]);
  if (result.rows[0]?.status !== "active") {
    throw new ApiError(403, "لا يمكن تنفيذ العملية قبل اعتماد الشركة.", "COMPANY_NOT_ACTIVE");
  }
}

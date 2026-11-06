import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, transaction } from "./db.js";

const migrationDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../database/migrations");
const lockId = 4_349_054_128;

async function migrate(): Promise<void> {
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [lockId]);
    await lock.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(migrationDirectory))
      .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
      .sort();
    for (const file of files) {
      const applied = await lock.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
      if (applied.rowCount) {
        console.log(`Already applied: ${file}`);
        continue;
      }
      const sql = await readFile(path.join(migrationDirectory, file), "utf8");
      await transaction(async (client) => {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      });
      console.log(`Applied: ${file}`);
    }
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [lockId]);
    lock.release();
    await pool.end();
  }
}

migrate().catch(async (error: unknown) => {
  console.error("Database migration failed", error);
  await pool.end();
  process.exitCode = 1;
});

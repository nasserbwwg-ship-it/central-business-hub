import "dotenv/config";
import { hashPassword } from "./auth.js";
import { pool, transaction } from "./db.js";
import { invariant } from "./errors.js";

async function seedAdmin(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const fullName = process.env.ADMIN_NAME?.trim();
  const companyName = process.env.ADMIN_COMPANY_NAME?.trim();
  invariant(email && password && fullName && companyName, 400,
    "Set ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME, and ADMIN_COMPANY_NAME in apps/api/.env before running this command.");
  invariant(password.length >= 12 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password),
    400, "ADMIN_PASSWORD must have at least 12 characters with upper, lower, numeric, and symbol characters.");
  const passwordHash = await hashPassword(password);

  await transaction(async (client) => {
    const existing = await client.query("SELECT 1 FROM users WHERE lower(email) = $1", [email]);
    invariant(!existing.rowCount, 409, "That administrator email already exists; refusing to replace its credentials.");
    const company = await client.query<{ id: string }>(
      `INSERT INTO companies (legal_name, display_name, type, status, contact_email)
       VALUES ($1, $1, 'operator', 'active', $2) RETURNING id`,
      [companyName, email],
    );
    const user = await client.query<{ id: string }>(
      "INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id",
      [email, fullName, passwordHash],
    );
    await client.query(
      "INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, 'owner')",
      [company.rows[0]!.id, user.rows[0]!.id],
    );
    await client.query(
      `INSERT INTO audit_events (company_id, actor_user_id, event_type, entity_type, entity_id)
       VALUES ($1, $2, 'operator.seeded', 'company', $1)`,
      [company.rows[0]!.id, user.rows[0]!.id],
    );
  });
  console.log(`Created platform administrator ${email}. Remove ADMIN_PASSWORD from the environment after setup.`);
}

seedAdmin().catch(async (error: unknown) => {
  console.error("Administrator seeding failed", error);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});

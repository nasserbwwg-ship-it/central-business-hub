import "dotenv/config";
import { hashPassword } from "./auth.js";
import { audit, pool, transaction } from "./db.js";
import { invariant } from "./errors.js";
import { emailSchema, parse, passwordSchema, textSchema } from "./validation.js";

async function bootstrapOwner(): Promise<void> {
  const emailValue = process.env.OWNER_BOOTSTRAP_EMAIL;
  const passwordValue = process.env.OWNER_BOOTSTRAP_PASSWORD;
  const nameValue = process.env.OWNER_BOOTSTRAP_NAME;
  if (!emailValue && !passwordValue && !nameValue) {
    console.log("Owner bootstrap skipped; setup variables are not configured.");
    return;
  }
  invariant(emailValue && passwordValue && nameValue, 400,
    "Set OWNER_BOOTSTRAP_EMAIL, OWNER_BOOTSTRAP_PASSWORD, and OWNER_BOOTSTRAP_NAME together for the one-time owner setup.");

  const email = parse(emailSchema, emailValue);
  const password = parse(passwordSchema, passwordValue);
  const fullName = parse(textSchema(2, 120), nameValue);
  const passwordHash = await hashPassword(password);

  const result = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["operator-owner-bootstrap"]);
    const completed = await client.query<{ email: string }>(
      "SELECT email FROM operator_owner_bootstrap_runs WHERE bootstrap_key = 'initial_owner'",
    );
    if (completed.rows[0]) {
      invariant(completed.rows[0].email === email, 409,
        "The one-time owner bootstrap was already completed for another email.");
      return "already-complete";
    }

    const user = await client.query<{ id: string; is_active: boolean }>(
      "SELECT id, is_active FROM users WHERE lower(email) = $1 FOR UPDATE",
      [email],
    );
    let userId: string;
    let companyId: string;
    let action: "created" | "password_reset";

    if (user.rows[0]) {
      userId = user.rows[0].id;
      invariant(user.rows[0].is_active, 409, "The existing owner account is disabled.", "OWNER_ACCOUNT_DISABLED");
      const membership = await client.query<{ company_id: string }>(
        `SELECT c.id AS company_id
         FROM company_memberships m
         JOIN companies c ON c.id = m.company_id
         WHERE m.user_id = $1 AND m.role = 'owner' AND c.type = 'operator' AND c.status = 'active'
         ORDER BY m.created_at
         LIMIT 1
         FOR UPDATE OF m, c`,
        [userId],
      );
      invariant(membership.rows[0], 409,
        "The email is already used by an account that is not an active platform owner.", "OWNER_EMAIL_IN_USE");
      companyId = membership.rows[0].company_id;
      await client.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, userId]);
      action = "password_reset";
    } else {
      const company = await client.query<{ id: string }>(
        `INSERT INTO companies (legal_name, display_name, type, status, contact_email)
         VALUES ('Central Business Hub Operator', 'Central Business Hub Operator', 'operator', 'active', $1)
         RETURNING id`,
        [email],
      );
      companyId = company.rows[0]!.id;
      const createdUser = await client.query<{ id: string }>(
        "INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id",
        [email, fullName, passwordHash],
      );
      userId = createdUser.rows[0]!.id;
      await client.query(
        "INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, 'owner')",
        [companyId, userId],
      );
      action = "created";
    }

    await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    await audit(client, companyId, userId, "operator.owner_bootstrapped", "company", companyId, { action });
    await client.query(
      "INSERT INTO operator_owner_bootstrap_runs (bootstrap_key, email) VALUES ('initial_owner', $1)",
      [email],
    );
    return action;
  });

  console.log(result === "already-complete"
    ? `Owner bootstrap was already completed for ${email}.`
    : `Platform owner ${result === "created" ? "created" : "password reset"} for ${email}.`);
}

bootstrapOwner()
  .catch((error: unknown) => {
    console.error("Platform owner bootstrap failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

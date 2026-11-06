import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { authenticate, clearCookies, cookieNames, createToken, hashPassword, hashToken, issueCookies, verifyPassword } from "./auth.js";
import { pool, query, transaction } from "./db.js";
import { ApiError, invariant } from "./errors.js";
import { emailSchema, parse, passwordSchema, textSchema, uuidSchema } from "./validation.js";

const router = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });
const registrationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false });
const registrationSchema = z.object({
  fullName: textSchema(2, 120),
  email: emailSchema,
  password: passwordSchema,
  companyName: textSchema(2, 200),
  companyType: z.enum(["customer", "supplier", "service_provider", "logistics_provider"]),
  registrationNumber: z.string().trim().max(80).optional(),
  taxNumber: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(40).optional(),
});

router.get("/csrf", async (request, response) => {
  const sessionToken: unknown = request.cookies?.[cookieNames.session];
  const cookieToken: unknown = request.cookies?.[cookieNames.csrf];
  const csrfToken = typeof cookieToken === "string" && cookieToken.length <= 100
    ? cookieToken
    : createToken();
  if (typeof sessionToken === "string" && sessionToken.length >= 40 && sessionToken.length <= 100) {
    await query(
      "UPDATE sessions SET csrf_hash = $1 WHERE token_hash = $2 AND expires_at > now()",
      [hashToken(csrfToken), hashToken(sessionToken)],
    );
  }
  response.cookie(cookieNames.csrf, csrfToken, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 1000 * 60 * 60 * 12,
  });
  response.json({ csrfToken });
});

router.post("/register", registrationLimiter, async (request, response) => {
  const input = parse(registrationSchema, request.body);
  const existing = await query("SELECT 1 FROM users WHERE lower(email) = $1", [input.email]);
  invariant(existing.rowCount === 0, 409, "هذا البريد مسجل بالفعل.", "EMAIL_ALREADY_REGISTERED");

  const passwordHash = await hashPassword(input.password);
  const sessionToken = createToken();
  const csrfToken = request.cookies?.[cookieNames.csrf] as string | undefined;
  invariant(csrfToken, 403, "حدّث الصفحة ثم أعد المحاولة.", "CSRF_TOKEN_MISSING");
  const result = await transaction(async (client) => {
    const company = await client.query<{ id: string }>(
      `INSERT INTO companies (legal_name, display_name, type, registration_number, tax_number, contact_email, contact_phone)
       VALUES ($1, $1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.companyName, input.companyType, input.registrationNumber ?? null, input.taxNumber ?? null, input.email, input.phone ?? null],
    );
    const user = await client.query<{ id: string }>(
      "INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id",
      [input.email, input.fullName, passwordHash],
    );
    const companyId = company.rows[0]!.id;
    const userId = user.rows[0]!.id;
    await client.query(
      "INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, 'owner')",
      [companyId, userId],
    );
    await client.query(
      `INSERT INTO sessions (token_hash, csrf_hash, user_id, active_company_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '12 hours')`,
      [hashToken(sessionToken), hashToken(csrfToken), userId, companyId],
    );
    await client.query(
      `INSERT INTO audit_events (company_id, actor_user_id, event_type, entity_type, entity_id)
       VALUES ($1, $2, 'company.registered', 'company', $1)`,
      [companyId, userId],
    );
    return { companyId, userId };
  });

  issueCookies(response, sessionToken, csrfToken);
  response.status(201).json({
    user: { id: result.userId, fullName: input.fullName, email: input.email },
    company: { id: result.companyId, displayName: input.companyName, type: input.companyType, status: "pending" },
    message: "تم إنشاء الحساب، ويظهر للمنصة بعد مراجعة بيانات الشركة واعتمادها.",
  });
});

router.post("/login", loginLimiter, async (request, response) => {
  const input = parse(z.object({ email: emailSchema, password: z.string().min(1).max(128) }), request.body);
  const user = await query<{ id: string; full_name: string; email: string; password_hash: string; is_active: boolean }>(
    "SELECT id, full_name, email, password_hash, is_active FROM users WHERE lower(email) = $1",
    [input.email],
  );
  const candidate = user.rows[0];
  if (!candidate || !candidate.is_active || !(await verifyPassword(input.password, candidate.password_hash))) {
    throw new ApiError(401, "البريد الإلكتروني أو كلمة المرور غير صحيحة.", "INVALID_CREDENTIALS");
  }

  const memberships = await query<{ company_id: string }>(
    "SELECT company_id FROM company_memberships WHERE user_id = $1 ORDER BY created_at LIMIT 1",
    [candidate.id],
  );
  invariant(memberships.rows[0], 403, "لا يوجد حساب شركة مرتبط بهذا المستخدم.", "MEMBERSHIP_REQUIRED");
  const sessionToken = createToken();
  const csrfToken = request.cookies?.[cookieNames.csrf] as string | undefined;
  invariant(csrfToken, 403, "حدّث الصفحة ثم أعد المحاولة.", "CSRF_TOKEN_MISSING");
  await query(
    `INSERT INTO sessions (token_hash, csrf_hash, user_id, active_company_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '12 hours')`,
    [hashToken(sessionToken), hashToken(csrfToken), candidate.id, memberships.rows[0].company_id],
  );
  issueCookies(response, sessionToken, csrfToken);
  response.json({ user: { id: candidate.id, fullName: candidate.full_name, email: candidate.email } });
});

router.get("/me", authenticate, async (request, response) => {
  const context = request.context!;
  const memberships = await query<{ company_id: string; display_name: string; type: string; status: string; role: string }>(
    `SELECT c.id AS company_id, c.display_name, c.type, c.status, m.role
     FROM company_memberships m JOIN companies c ON c.id = m.company_id
     WHERE m.user_id = $1 ORDER BY c.display_name`,
    [context.userId],
  );
  response.json({
    user: { id: context.userId, fullName: context.fullName, email: context.email },
    activeCompany: {
      id: context.companyId,
      displayName: memberships.rows.find((item) => item.company_id === context.companyId)?.display_name,
      type: context.companyType,
      status: context.companyStatus,
      role: context.role,
    },
    memberships: memberships.rows,
  });
});

router.post("/switch-company", authenticate, async (request, response) => {
  const input = parse(z.object({ companyId: uuidSchema }), request.body);
  const membership = await query<{ company_id: string }>(
    "SELECT company_id FROM company_memberships WHERE user_id = $1 AND company_id = $2",
    [request.context!.userId, input.companyId],
  );
  invariant(membership.rowCount === 1, 403, "لا تملك عضوية في الشركة المطلوبة.", "MEMBERSHIP_REQUIRED");
  await query("UPDATE sessions SET active_company_id = $1 WHERE token_hash = $2", [input.companyId, request.context!.sessionTokenHash]);
  response.json({ companyId: input.companyId });
});

router.post("/logout", async (request, response) => {
  const token: unknown = request.cookies?.[cookieNames.session];
  if (typeof token === "string" && token.length <= 100) {
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
  }
  clearCookies(response);
  response.status(204).end();
});

export default router;

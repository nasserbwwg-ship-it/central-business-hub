import { Router } from "express";
import { z } from "zod";
import { authenticate, requireOperator, requireRole } from "./auth.js";
import { audit, ensureCompanyActive, query, transaction } from "./db.js";
import { invariant } from "./errors.js";
import { parse, textSchema, uuidSchema } from "./validation.js";

const router = Router();
const adminRoles = ["owner", "admin"] as const;
const companyUpdateSchema = z.object({
  displayName: textSchema(2, 200).optional(),
  contactEmail: z.email().max(254).optional(),
  contactPhone: z.string().trim().max(40).optional(),
  registrationNumber: z.string().trim().max(80).optional(),
  taxNumber: z.string().trim().max(80).optional(),
}).strict();

router.get("/companies/me", authenticate, async (request, response) => {
  const { companyId } = request.context!;
  const result = await query(
    `SELECT id, legal_name AS "legalName", display_name AS "displayName", type, status,
            registration_number AS "registrationNumber", tax_number AS "taxNumber",
            contact_email AS "contactEmail", contact_phone AS "contactPhone", created_at AS "createdAt"
     FROM companies WHERE id = $1`,
    [companyId],
  );
  response.json(result.rows[0]);
});

router.patch("/companies/me", authenticate, requireRole(...adminRoles), async (request, response) => {
  const input = parse(companyUpdateSchema, request.body);
  const updates: string[] = [];
  const values: unknown[] = [];
  const fields: Array<[keyof typeof input, string]> = [
    ["displayName", "display_name"],
    ["contactEmail", "contact_email"],
    ["contactPhone", "contact_phone"],
    ["registrationNumber", "registration_number"],
    ["taxNumber", "tax_number"],
  ];
  for (const [key, column] of fields) {
    const value = input[key];
    if (value !== undefined) {
      values.push(value);
      updates.push(`${column} = $${values.length}`);
    }
  }
  invariant(updates.length > 0, 400, "أدخل حقلًا واحدًا على الأقل للتحديث.");
  values.push(request.context!.companyId);
  const result = await query(
    `UPDATE companies SET ${updates.join(", ")}, updated_at = now() WHERE id = $${values.length}
     RETURNING id, legal_name AS "legalName", display_name AS "displayName", type, status,
               registration_number AS "registrationNumber", tax_number AS "taxNumber",
               contact_email AS "contactEmail", contact_phone AS "contactPhone"`,
    values,
  );
  response.json(result.rows[0]);
});

router.get("/companies/me/members", authenticate, async (request, response) => {
  const result = await query(
    `SELECT u.id, u.full_name AS "fullName", u.email, m.role, m.created_at AS "joinedAt"
     FROM company_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.company_id = $1 ORDER BY m.created_at`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.post("/companies/me/members", authenticate, requireRole(...adminRoles), async (request, response) => {
  const input = parse(z.object({
    email: z.email().max(254).transform((email) => email.trim().toLowerCase()),
    role: z.enum(["admin", "manager", "purchaser", "warehouse", "accountant", "sales", "driver", "member"]),
  }), request.body);
  const user = await query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1 AND is_active = true", [input.email]);
  invariant(user.rows[0], 404, "المستخدم غير مسجل. على المستخدم إنشاء حساب أولًا.", "USER_NOT_FOUND");
  const context = request.context!;
  await transaction(async (client) => {
    const membership = await client.query(
      `INSERT INTO company_memberships (company_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING user_id`,
      [context.companyId, user.rows[0]!.id, input.role],
    );
    invariant(membership.rowCount === 1, 409, "هذا المستخدم عضو بالفعل في الشركة.", "MEMBERSHIP_ALREADY_EXISTS");
    await audit(client, context.companyId, context.userId, "membership.created", "company_membership", user.rows[0]!.id, { role: input.role });
  });
  response.status(201).json({ userId: user.rows[0].id, role: input.role });
});

router.get("/companies/me/branches", authenticate, async (request, response) => {
  const result = await query(
    `SELECT id, name, city, address, is_warehouse AS "isWarehouse", created_at AS "createdAt"
     FROM branches WHERE company_id = $1 ORDER BY created_at DESC`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.post("/companies/me/branches", authenticate, requireRole(...adminRoles, "manager"), async (request, response) => {
  const input = parse(z.object({
    name: textSchema(2, 120),
    city: textSchema(2, 100),
    address: z.string().trim().max(500).optional(),
    isWarehouse: z.boolean().default(false),
  }), request.body);
  await ensureCompanyActive(request.context!.companyId);
  const result = await query(
    `INSERT INTO branches (company_id, name, city, address, is_warehouse)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, name, city, address, is_warehouse AS "isWarehouse", created_at AS "createdAt"`,
    [request.context!.companyId, input.name, input.city, input.address ?? null, input.isWarehouse],
  );
  response.status(201).json(result.rows[0]);
});

router.get("/admin/companies", authenticate, requireOperator, requireRole("owner"), async (request, response) => {
  const status = request.query.status;
  const validStatus = status === "pending" || status === "active" || status === "suspended" ? status : null;
  const result = await query(
    `SELECT c.id, c.legal_name AS "legalName", c.display_name AS "displayName", c.type, c.status,
            c.registration_number AS "registrationNumber", c.tax_number AS "taxNumber",
            c.contact_email AS "contactEmail", c.contact_phone AS "contactPhone", c.created_at AS "createdAt"
     FROM companies c WHERE c.type <> 'operator' AND ($1::company_status IS NULL OR c.status = $1)
     ORDER BY CASE c.status WHEN 'pending' THEN 0 ELSE 1 END, c.created_at DESC LIMIT 200`,
    [validStatus],
  );
  response.json({ data: result.rows });
});

router.patch("/admin/companies/:id/status", authenticate, requireOperator, requireRole("owner"), async (request, response) => {
  const companyId = parse(uuidSchema, request.params.id);
  const input = parse(z.object({ status: z.enum(["active", "suspended"]) }), request.body);
  const result = await transaction(async (client) => {
    const updated = await client.query<{ status: string; display_name: string }>(
      `UPDATE companies SET status = $1, updated_at = now()
       WHERE id = $2 AND type <> 'operator'
       RETURNING status, display_name`,
      [input.status, companyId],
    );
    invariant(updated.rows[0], 404, "الشركة غير موجودة.", "COMPANY_NOT_FOUND");
    await audit(client, companyId, request.context!.userId, `company.${input.status}`, "company", companyId, {
      changedBy: request.context!.companyId,
    });
    return updated.rows[0];
  });
  response.json({ id: companyId, status: result.status, displayName: result.display_name });
});

router.delete("/companies/me/members/:userId", authenticate, requireRole(...adminRoles), async (request, response) => {
  const userId = parse(uuidSchema, request.params.userId);
  invariant(userId !== request.context!.userId, 400, "لا يمكن إزالة عضويتك الحالية.", "CANNOT_REMOVE_SELF");
  const result = await query(
    "DELETE FROM company_memberships WHERE company_id = $1 AND user_id = $2 RETURNING user_id",
    [request.context!.companyId, userId],
  );
  invariant(result.rowCount === 1, 404, "عضوية المستخدم غير موجودة.", "MEMBERSHIP_NOT_FOUND");
  response.status(204).end();
});

export default router;

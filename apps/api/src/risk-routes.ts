import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "./auth.js";
import { audit, ensureCompanyActive, query, transaction } from "./db.js";
import { ApiError, invariant } from "./errors.js";
import { parse, textSchema, uuidSchema } from "./validation.js";

const router = Router();
const managerRoles = ["owner", "admin", "manager"] as const;

function reference(prefix: string): string {
  return `${prefix}-${new Date().getFullYear()}-${randomBytes(8).toString("hex").toUpperCase()}`;
}

router.get("/claims", authenticate, async (request, response) => {
  const result = await query(
    `SELECT cl.id, cl.reference, cl.order_id AS "orderId", cl.shipment_id AS "shipmentId",
            cl.claimant_company_id AS "claimantCompanyId", cl.respondent_company_id AS "respondentCompanyId",
            cl.title, cl.description, cl.status, cl.resolution, cl.created_at AS "createdAt",
            claimant.display_name AS "claimantName", respondent.display_name AS "respondentName"
     FROM claims cl JOIN companies claimant ON claimant.id = cl.claimant_company_id
     JOIN companies respondent ON respondent.id = cl.respondent_company_id
     WHERE cl.claimant_company_id = $1 OR cl.respondent_company_id = $1
     ORDER BY cl.created_at DESC LIMIT 200`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.post("/claims", authenticate, requireRole(...managerRoles, "purchaser"), async (request, response) => {
  const input = parse(z.object({
    orderId: uuidSchema,
    shipmentId: uuidSchema.optional(),
    respondentCompanyId: uuidSchema.optional(),
    title: textSchema(4, 200),
    description: textSchema(10, 4000),
  }).strict(), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const created = await transaction(async (client) => {
    const order = await client.query<{ customer_company_id: string; supplier_company_id: string }>(
      "SELECT customer_company_id, supplier_company_id FROM orders WHERE id = $1",
      [input.orderId],
    );
    const orderRecord = order.rows[0];
    invariant(orderRecord, 404, "أمر الشراء المرتبط بالشكوى غير موجود.", "ORDER_NOT_FOUND");
    const isCustomer = orderRecord.customer_company_id === context.companyId;
    const isSupplier = orderRecord.supplier_company_id === context.companyId;
    invariant(isCustomer || isSupplier, 403, "لا تملك صلاحية على أمر الشراء.", "ORDER_FORBIDDEN");
    const otherParty = isCustomer ? orderRecord.supplier_company_id : orderRecord.customer_company_id;
    invariant(!input.respondentCompanyId || otherParty === input.respondentCompanyId, 400, "الطرف المقابل لا يطابق أطراف أمر الشراء.", "INVALID_RESPONDENT");
    if (input.shipmentId) {
      const shipment = await client.query(
        "SELECT 1 FROM shipments WHERE id = $1 AND order_id = $2 AND (customer_company_id = $3 OR carrier_company_id = $3)",
        [input.shipmentId, input.orderId, context.companyId],
      );
      invariant(shipment.rowCount === 1, 404, "الشحنة غير مرتبطة بالطلب أو ليست متاحة لشركتك.", "SHIPMENT_NOT_FOUND");
    }
    const claim = await client.query(
      `INSERT INTO claims (reference, order_id, shipment_id, claimant_company_id, respondent_company_id, title, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, reference, status, title, description, created_at AS "createdAt"`,
      [reference("CLM"), input.orderId, input.shipmentId ?? null, context.companyId, otherParty, input.title, input.description, context.userId],
    );
    await audit(client, context.companyId, context.userId, "claim.created", "claim", claim.rows[0].id);
    return claim.rows[0];
  });
  response.status(201).json(created);
});

router.patch("/claims/:id/status", authenticate, requireRole(...managerRoles), async (request, response) => {
  const claimId = parse(uuidSchema, request.params.id);
  const input = parse(z.object({
    status: z.enum(["under_review", "resolved", "rejected", "closed"]),
    resolution: z.string().trim().min(5).max(4000).optional(),
  }).strict(), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const result = await transaction(async (client) => {
    const claim = await client.query<{ status: string; claimant_company_id: string; respondent_company_id: string }>(
      "SELECT status, claimant_company_id, respondent_company_id FROM claims WHERE id = $1 FOR UPDATE",
      [claimId],
    );
    const record = claim.rows[0];
    invariant(record && (record.claimant_company_id === context.companyId || record.respondent_company_id === context.companyId), 404, "الشكوى غير موجودة.", "CLAIM_NOT_FOUND");
    const claimantClosing = context.companyId === record.claimant_company_id && record.status === "resolved" && input.status === "closed";
    const respondentHandling = context.companyId === record.respondent_company_id && record.status !== "closed"
      && ["under_review", "resolved", "rejected"].includes(input.status);
    invariant(claimantClosing || respondentHandling, 409, "لا يسمح بتغيير حالة الشكوى في هذه المرحلة.", "INVALID_STATUS_TRANSITION");
    if (["resolved", "rejected"].includes(input.status)) {
      invariant(input.resolution, 400, "أضف تفاصيل الإجراء أو سبب الرفض.", "RESOLUTION_REQUIRED");
    }
    const changed = await client.query(
      `UPDATE claims SET status = $1, resolution = COALESCE($2, resolution),
         resolved_at = CASE WHEN $1::claim_status IN ('resolved', 'rejected') THEN now() ELSE resolved_at END
       WHERE id = $3 RETURNING id, reference, status, resolution, resolved_at AS "resolvedAt"`,
      [input.status, input.resolution ?? null, claimId],
    );
    await audit(client, context.companyId, context.userId, `claim.${input.status}`, "claim", claimId);
    return changed.rows[0];
  });
  response.json(result);
});

const sensitiveConfigurationKey = /(password|secret|token|credential|api.?key|private.?key)/i;
const configurationSchema = z.record(z.string().trim().max(80), z.union([
  z.string().max(500),
  z.boolean(),
  z.number().finite(),
])).refine(
  (configuration) => Object.keys(configuration).every((key) => !sensitiveConfigurationKey.test(key)),
  "لا تخزن كلمات مرور أو مفاتيح أو بيانات اعتماد في إعداد الاتصال.",
);

router.get("/integrations", authenticate, async (request, response) => {
  const result = await query(
    `SELECT id, integration_type AS "integrationType", name, endpoint_url AS "endpointUrl",
            status, configuration, created_at AS "createdAt"
     FROM integration_connections WHERE company_id = $1 ORDER BY created_at DESC`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.post("/integrations", authenticate, requireRole(...managerRoles), async (request, response) => {
  const input = parse(z.object({
    integrationType: z.enum(["erp", "pos", "accounting", "shipping", "barcode", "other"]),
    name: textSchema(2, 120),
    endpointUrl: z.url().optional(),
    configuration: configurationSchema.default({}),
  }).strict(), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  if (input.endpointUrl) {
    const endpoint = new URL(input.endpointUrl);
    invariant(endpoint.protocol === "https:" || ["localhost", "127.0.0.1"].includes(endpoint.hostname), 400,
      "استخدم HTTPS لنقاط التكامل الخارجية.", "INSECURE_ENDPOINT");
    invariant(!endpoint.username && !endpoint.password, 400, "لا تضع بيانات اعتماد ضمن عنوان الاتصال.", "CREDENTIALS_IN_URL");
    invariant(!endpoint.search && !endpoint.hash, 400, "لا تضع رموزًا أو بيانات اعتماد ضمن عنوان الاتصال.", "CREDENTIALS_IN_URL");
  }
  const created = await transaction(async (client) => {
    const connection = await client.query(
      `INSERT INTO integration_connections (company_id, integration_type, name, endpoint_url, configuration)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, integration_type AS "integrationType", name, endpoint_url AS "endpointUrl",
                 status, configuration, created_at AS "createdAt"`,
      [context.companyId, input.integrationType, input.name, input.endpointUrl ?? null, JSON.stringify(input.configuration)],
    );
    await audit(client, context.companyId, context.userId, "integration.registered", "integration", connection.rows[0].id);
    return connection.rows[0];
  });
  response.status(201).json({ ...created, message: "تم تسجيل إعداد نقطة التكامل فقط؛ يلزم تطوير موصل واختباره مع مزود النظام قبل التبادل الفعلي." });
});

router.patch("/integrations/:id/status", authenticate, requireRole(...managerRoles), async (request, response) => {
  const id = parse(uuidSchema, request.params.id);
  const input = parse(z.object({ status: z.enum(["pending", "disabled"]) }), request.body);
  const result = await query(
    `UPDATE integration_connections SET status = $1 WHERE id = $2 AND company_id = $3
     RETURNING id, name, status`,
    [input.status, id, request.context!.companyId],
  );
  invariant(result.rows[0], 404, "إعداد التكامل غير موجود في شركتك.", "INTEGRATION_NOT_FOUND");
  response.json(result.rows[0]);
});

export default router;

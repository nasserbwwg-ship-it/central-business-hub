import { Router } from "express";
import { z } from "zod";
import { authenticate, requireCompany, requireRole } from "./auth.js";
import { audit, ensureCompanyActive, query, transaction } from "./db.js";
import { ApiError, invariant } from "./errors.js";
import { tryAutoAcceptManagedQuote } from "./managed-inventory.js";
import { assertRfqProductConstraints, parse, quantitySchema, rfqAwardStatus, textSchema, uuidSchema } from "./validation.js";

const router = Router();
const rfqItemSchema = z.object({
  productId: uuidSchema.optional(),
  description: textSchema(2, 300),
  quantity: quantitySchema,
  unit: textSchema(1, 40),
});

router.get("/rfqs", authenticate, async (request, response) => {
  const context = request.context!;
  if (context.companyType === "customer" || context.companyType === "operator") {
    const result = await query(
      `SELECT r.id, r.reference, r.title, r.notes, r.status, r.response_due_at AS "responseDueAt",
              r.created_at AS "createdAt",
              (SELECT count(*)::int FROM supplier_quotes q WHERE q.rfq_id = r.id) AS "quoteCount"
       FROM rfqs r WHERE r.customer_company_id = $1 ORDER BY r.created_at DESC LIMIT 200`,
      [context.companyId],
    );
    response.json({ data: result.rows });
    return;
  }
  if (context.companyType === "supplier") {
    const result = await query(
      `SELECT r.id, r.reference, r.title, r.notes, r.status, r.response_due_at AS "responseDueAt",
              r.created_at AS "createdAt",
              q.id AS "myQuoteId", q.status AS "myQuoteStatus", q.total_amount AS "myQuoteAmount"
       FROM rfq_suppliers invited
       JOIN rfqs r ON r.id = invited.rfq_id
       LEFT JOIN supplier_quotes q ON q.rfq_id = r.id AND q.supplier_company_id = $1
       WHERE invited.supplier_company_id = $1
         AND r.status IN ('open', 'reviewing', 'partially_awarded', 'awarded', 'closed')
       ORDER BY r.created_at DESC LIMIT 200`,
      [context.companyId],
    );
    response.json({ data: result.rows });
    return;
  }
  throw new ApiError(403, "منصة الشركة الحالية لا تدير طلبات التوريد.", "COMPANY_TYPE_FORBIDDEN");
});

router.post("/rfqs", authenticate, requireCompany("customer"), requireRole("owner", "admin", "manager", "purchaser"), async (request, response) => {
  const input = parse(z.object({
    title: textSchema(3, 200),
    notes: z.string().trim().max(4000).optional(),
    responseDueAt: z.iso.datetime().optional(),
    supplierCompanyIds: z.array(uuidSchema).min(1).max(50),
    items: z.array(rfqItemSchema).min(1).max(100),
  }).strict(), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const supplierIds = [...new Set(input.supplierCompanyIds)];
  invariant(supplierIds.length === input.supplierCompanyIds.length, 400, "تحتوي قائمة الموردين على قيم مكررة.");

  const created = await transaction(async (client) => {
    const suppliers = await client.query<{ id: string }>(
      "SELECT id FROM companies WHERE id = ANY($1::uuid[]) AND type = 'supplier' AND status = 'active'",
      [supplierIds],
    );
    invariant(suppliers.rowCount === supplierIds.length, 400, "اختر موردين معتمدين فقط.", "INVALID_SUPPLIER");
    const productIds = [...new Set(input.items.flatMap((item) => item.productId ? [item.productId] : []))];
    const productSuppliers = new Map<string, string>();
    if (productIds.length) {
      const products = await client.query<{ id: string; supplier_company_id: string; minimum_order_quantity: string }>(
        `SELECT id, supplier_company_id, minimum_order_quantity
         FROM products WHERE id = ANY($1::uuid[]) AND is_active = true`,
        [productIds],
      );
      invariant(products.rowCount === productIds.length, 400, "يتضمن الطلب منتجًا غير متاح.", "PRODUCT_NOT_AVAILABLE");
      assertRfqProductConstraints(input.items, products.rows, supplierIds);
      for (const product of products.rows) productSuppliers.set(product.id, product.supplier_company_id);
    }

    const rfq = await client.query<{ id: string; reference: string; status: string; created_at: Date }>(
      `INSERT INTO rfqs (customer_company_id, title, notes, status, response_due_at, created_by)
       VALUES ($1, $2, $3, 'open', $4, $5)
       RETURNING id, reference, status, created_at`,
      [context.companyId, input.title, input.notes ?? null, input.responseDueAt ?? null, context.userId],
    );
    const rfqId = rfq.rows[0]!.id;
    await client.query(
      "INSERT INTO rfq_suppliers (rfq_id, supplier_company_id) SELECT $1, unnest($2::uuid[])",
      [rfqId, supplierIds],
    );
    for (const item of input.items) {
      await client.query(
        `INSERT INTO rfq_items (rfq_id, product_id, supplier_company_id, description, quantity, unit)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [rfqId, item.productId ?? null, item.productId ? productSuppliers.get(item.productId) ?? null : null,
          item.description, item.quantity, item.unit],
      );
    }
    await audit(client, context.companyId, context.userId, "rfq.created", "rfq", rfqId, { invitedSuppliers: supplierIds.length });
    return rfq.rows[0];
  });
  response.status(201).json(created);
});

router.get("/rfqs/:id", authenticate, async (request, response) => {
  const rfqId = parse(uuidSchema, request.params.id);
  const context = request.context!;
  const rfq = await query(
    `SELECT r.id, r.reference,
            CASE WHEN $3::text IN ('customer', 'operator') THEN r.customer_company_id END AS "customerCompanyId",
            r.title, r.notes,
            r.status, r.response_due_at AS "responseDueAt", r.created_at AS "createdAt"
     FROM rfqs r
     WHERE r.id = $1 AND (
       r.customer_company_id = $2 OR
       EXISTS (SELECT 1 FROM rfq_suppliers s WHERE s.rfq_id = r.id AND s.supplier_company_id = $2)
     )`,
    [rfqId, context.companyId, context.companyType],
  );
  invariant(rfq.rows[0], 404, "طلب العرض غير موجود أو غير متاح لشركتك.", "RFQ_NOT_FOUND");
  const items = await query(
    `SELECT i.id, i.product_id AS "productId",
            CASE WHEN $3::text IN ('customer', 'operator') THEN i.supplier_company_id END AS "supplierCompanyId",
            CASE WHEN $3::text IN ('customer', 'operator') THEN supplier.display_name END AS "supplierName",
            i.description, i.quantity, i.unit
     FROM rfq_items i LEFT JOIN companies supplier ON supplier.id = i.supplier_company_id
     WHERE i.rfq_id = $1
       AND ($3::text IN ('customer', 'operator') OR i.supplier_company_id IS NULL OR i.supplier_company_id = $2)
     ORDER BY i.id`,
    [rfqId, context.companyId, context.companyType],
  );
  const quotes = context.companyType === "customer"
    ? await query(
      `SELECT q.id, q.supplier_company_id AS "supplierCompanyId", c.display_name AS "supplierName",
              q.status, q.currency, q.total_amount AS "totalAmount", q.valid_until AS "validUntil",
              q.notes, q.submitted_at AS "submittedAt"
       FROM supplier_quotes q JOIN companies c ON c.id = q.supplier_company_id
       WHERE q.rfq_id = $1 ORDER BY q.submitted_at`,
      [rfqId],
    )
    : await query(
      `SELECT id, status, currency, total_amount AS "totalAmount", valid_until AS "validUntil",
              notes, submitted_at AS "submittedAt"
       FROM supplier_quotes WHERE rfq_id = $1 AND supplier_company_id = $2`,
      [rfqId, context.companyId],
    );
  response.json({ ...rfq.rows[0], items: items.rows, quotes: quotes.rows });
});

router.post("/rfqs/:id/quotes", authenticate, requireCompany("supplier"), requireRole("owner", "admin", "manager", "sales"), async (request, response) => {
  const rfqId = parse(uuidSchema, request.params.id);
  const input = parse(z.object({
    totalAmount: z.number().finite().nonnegative().max(1_000_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/).default("SAR"),
    validUntil: z.iso.date().optional(),
    notes: z.string().trim().max(2000).optional(),
  }).strict(), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const created = await transaction(async (client) => {
    const invited = await client.query<{ status: string; response_due_at: Date | null }>(
      `SELECT r.status, r.response_due_at FROM rfq_suppliers s JOIN rfqs r ON r.id = s.rfq_id
       WHERE s.rfq_id = $1 AND s.supplier_company_id = $2 FOR UPDATE OF r`,
      [rfqId, context.companyId],
    );
    const invitation = invited.rows[0];
    invariant(invitation && ["open", "reviewing", "partially_awarded"].includes(invitation.status),
      404, "الطلب غير مفتوح لشركتك.", "RFQ_NOT_AVAILABLE");
    invariant(!invitation.response_due_at || invitation.response_due_at.getTime() >= Date.now(),
      409, "انتهى الموعد المحدد لاستقبال العروض.", "RFQ_RESPONSE_DEADLINE_PASSED");
    const eligibleItems = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM rfq_items
       WHERE rfq_id = $1 AND (supplier_company_id IS NULL OR supplier_company_id = $2)`,
      [rfqId, context.companyId],
    );
    invariant(eligibleItems.rows[0]!.count > 0, 403, "لا توجد بنود توريد مخصصة لشركتك في هذا الطلب.", "RFQ_HAS_NO_SUPPLIER_ITEMS");
    const quote = await client.query(
      `INSERT INTO supplier_quotes (rfq_id, supplier_company_id, currency, total_amount, valid_until, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, rfq_id AS "rfqId", status, currency, total_amount AS "totalAmount",
                 valid_until AS "validUntil", notes, submitted_at AS "submittedAt"`,
      [rfqId, context.companyId, input.currency, input.totalAmount.toFixed(2), input.validUntil ?? null, input.notes ?? null],
    );
    await client.query(
      "UPDATE rfqs SET status = CASE WHEN status = 'partially_awarded' THEN status ELSE 'reviewing'::rfq_status END, updated_at = now() WHERE id = $1",
      [rfqId],
    );
    await tryAutoAcceptManagedQuote(
      client,
      quote.rows[0].id,
      rfqId,
      context.companyId,
      String(quote.rows[0].totalAmount),
      input.currency,
      input.validUntil ?? null,
    );
    const finalQuote = await client.query<{ status: string; order_reference: string | null }>(
      `SELECT q.status, o.reference AS order_reference
       FROM supplier_quotes q LEFT JOIN orders o ON o.quote_id = q.id
       WHERE q.id = $1`,
      [quote.rows[0].id],
    );
    await audit(client, context.companyId, context.userId, "quote.submitted", "supplier_quote", quote.rows[0].id);
    return {
      ...quote.rows[0],
      status: finalQuote.rows[0]!.status,
      orderReference: finalQuote.rows[0]!.order_reference,
    };
  });
  response.status(201).json(created);
});

router.post("/quotes/:id/reject", authenticate, requireCompany("customer"), requireRole("owner", "admin", "manager", "purchaser"), async (request, response) => {
  const quoteId = parse(uuidSchema, request.params.id);
  const context = request.context!;
  const updated = await transaction(async (client) => {
    const result = await client.query<{ id: string; rfq_id: string; status: string }>(
      `UPDATE supplier_quotes q SET status = 'rejected'
       FROM rfqs r
       WHERE q.rfq_id = r.id AND q.id = $1 AND r.customer_company_id = $2 AND q.status = 'submitted'
       RETURNING q.id, q.rfq_id, q.status`,
      [quoteId, context.companyId],
    );
    invariant(result.rows[0], 404, "العرض غير موجود أو لم يعد قابلًا للرفض.", "QUOTE_NOT_FOUND");
    await audit(client, context.companyId, context.userId, "quote.rejected", "supplier_quote", quoteId);
    return result.rows[0];
  });
  response.json(updated);
});

router.post("/quotes/:id/accept", authenticate, requireCompany("customer"), requireRole("owner", "admin", "manager", "purchaser"), async (request, response) => {
  const quoteId = parse(uuidSchema, request.params.id);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const order = await transaction(async (client) => {
    const quote = await client.query<{
      id: string; rfq_id: string; customer_company_id: string; supplier_company_id: string;
      total_amount: string; currency: string; status: string; rfq_status: string;
    }>(
      `SELECT q.id, q.rfq_id, r.customer_company_id, q.supplier_company_id,
              q.total_amount, q.currency, q.status, r.status AS rfq_status
       FROM supplier_quotes q JOIN rfqs r ON r.id = q.rfq_id
       WHERE q.id = $1 AND r.customer_company_id = $2
       FOR UPDATE OF q, r`,
      [quoteId, context.companyId],
    );
    const selected = quote.rows[0];
    invariant(selected, 404, "العرض غير موجود في طلب شركتك.", "QUOTE_NOT_FOUND");
    invariant(selected.status === "submitted" && ["open", "reviewing", "partially_awarded"].includes(selected.rfq_status), 409, "لم يعد بالإمكان اعتماد هذا العرض.", "QUOTE_NOT_ACTIONABLE");
    await client.query("UPDATE supplier_quotes SET status = 'accepted' WHERE id = $1", [quoteId]);
    const awards = await client.query<{ invited_count: number; accepted_count: number }>(
      `SELECT count(DISTINCT s.supplier_company_id)::int AS invited_count,
              count(DISTINCT q.supplier_company_id) FILTER (WHERE q.status = 'accepted')::int AS accepted_count
       FROM rfq_suppliers s LEFT JOIN supplier_quotes q ON q.rfq_id = s.rfq_id
         AND q.supplier_company_id = s.supplier_company_id
       WHERE s.rfq_id = $1`,
      [selected.rfq_id],
    );
    const awardedStatus = rfqAwardStatus(awards.rows[0]!.invited_count, awards.rows[0]!.accepted_count);
    await client.query("UPDATE rfqs SET status = $1, updated_at = now() WHERE id = $2", [awardedStatus, selected.rfq_id]);
    const created = await client.query(
      `INSERT INTO orders (rfq_id, quote_id, customer_company_id, supplier_company_id, currency, total_amount)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, reference, rfq_id AS "rfqId", status, currency,
                 total_amount AS "totalAmount", created_at AS "createdAt"`,
      [selected.rfq_id, quoteId, context.companyId, selected.supplier_company_id, selected.currency, selected.total_amount],
    );
    await client.query(
      `UPDATE managed_replenishments
       SET status = 'ordered', order_id = $1, authorized_amount = $2, block_reason = NULL, updated_at = now()
       WHERE rfq_id = $3 AND status IN ('pending_quote', 'requires_approval')`,
      [created.rows[0].id, selected.total_amount, selected.rfq_id],
    );
    await audit(client, context.companyId, context.userId, "quote.accepted", "supplier_quote", quoteId, { orderId: created.rows[0].id });
    return created.rows[0];
  });
  response.status(201).json(order);
});

router.post("/rfqs/:id/cancel", authenticate, requireCompany("customer"), requireRole("owner", "admin", "manager", "purchaser"), async (request, response) => {
  const rfqId = parse(uuidSchema, request.params.id);
  const context = request.context!;
  const changed = await transaction(async (client) => {
    const result = await client.query(
      `UPDATE rfqs SET status = 'cancelled', updated_at = now()
       WHERE id = $1 AND customer_company_id = $2 AND status IN ('draft', 'open', 'reviewing', 'partially_awarded')
       RETURNING id, reference, status`,
      [rfqId, context.companyId],
    );
    invariant(result.rows[0], 404, "الطلب غير موجود أو لا يمكن إلغاؤه.", "RFQ_NOT_CANCELLABLE");
    await client.query("UPDATE supplier_quotes SET status = 'withdrawn' WHERE rfq_id = $1 AND status = 'submitted'", [rfqId]);
    await audit(client, context.companyId, context.userId, "rfq.cancelled", "rfq", rfqId);
    return result.rows[0];
  });
  response.json(changed);
});

router.post("/rfqs/:id/close", authenticate, requireCompany("customer"), requireRole("owner", "admin", "manager", "purchaser"), async (request, response) => {
  const rfqId = parse(uuidSchema, request.params.id);
  const context = request.context!;
  const closed = await transaction(async (client) => {
    const result = await client.query(
      `UPDATE rfqs SET status = 'closed', updated_at = now()
       WHERE id = $1 AND customer_company_id = $2 AND status IN ('open', 'reviewing', 'partially_awarded')
       RETURNING id, reference, status`,
      [rfqId, context.companyId],
    );
    invariant(result.rows[0], 404, "الطلب غير موجود أو مغلق بالفعل.", "RFQ_NOT_OPEN");
    await client.query(
      "UPDATE supplier_quotes SET status = 'withdrawn' WHERE rfq_id = $1 AND status = 'submitted'",
      [rfqId],
    );
    await audit(client, context.companyId, context.userId, "rfq.closed", "rfq", rfqId);
    return result.rows[0];
  });
  response.json(closed);
});

router.get("/orders", authenticate, async (request, response) => {
  const context = request.context!;
  if (context.companyType !== "customer" && context.companyType !== "supplier" && context.companyType !== "operator") {
    throw new ApiError(403, "لا تتاح الطلبات التجارية لهذه المنصة.", "COMPANY_TYPE_FORBIDDEN");
  }
  const column = context.companyType === "supplier" ? "supplier_company_id" : "customer_company_id";
  const result = await query(
    `SELECT o.id, o.reference, o.status, o.currency, o.total_amount AS "totalAmount",
            o.customer_company_id AS "customerCompanyId", o.supplier_company_id AS "supplierCompanyId",
            o.rfq_id AS "rfqId", r.title AS "requestTitle", o.confirmed_at AS "confirmedAt"
     FROM orders o JOIN rfqs r ON r.id = o.rfq_id
     WHERE o.${column} = $1 ORDER BY o.created_at DESC LIMIT 200`,
    [context.companyId],
  );
  response.json({ data: result.rows });
});

router.patch("/orders/:id/status", authenticate, requireRole("owner", "admin", "manager", "sales", "purchaser"), async (request, response) => {
  const orderId = parse(uuidSchema, request.params.id);
  const input = parse(z.object({ status: z.enum(["processing", "partially_fulfilled", "cancelled"]) }), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const updated = await transaction(async (client) => {
    const order = await client.query<{ status: string; customer_company_id: string; supplier_company_id: string }>(
      "SELECT status, customer_company_id, supplier_company_id FROM orders WHERE id = $1 FOR UPDATE",
      [orderId],
    );
    const record = order.rows[0];
    invariant(record, 404, "أمر الشراء غير موجود.", "ORDER_NOT_FOUND");
    const isSupplier = record.supplier_company_id === context.companyId;
    const isCustomer = record.customer_company_id === context.companyId;
    invariant(isSupplier || isCustomer, 404, "أمر الشراء غير موجود في شركتك.", "ORDER_NOT_FOUND");
    const supplierTransition = isSupplier && (
      (input.status === "processing" && record.status === "confirmed")
      || (input.status === "partially_fulfilled" && record.status === "processing")
    );
    const customerCancel = isCustomer && input.status === "cancelled" && record.status === "confirmed";
    invariant(supplierTransition || customerCancel, 409, "تغيير الحالة غير مسموح في هذه المرحلة.", "INVALID_STATUS_TRANSITION");
    await client.query("UPDATE orders SET status = $1 WHERE id = $2", [input.status, orderId]);
    if (input.status === "cancelled") {
      await client.query(
        `UPDATE managed_replenishments SET status = 'cancelled', updated_at = now()
         WHERE order_id = $1 AND status = 'ordered'`,
        [orderId],
      );
    }
    await audit(client, context.companyId, context.userId, `order.${input.status}`, "order", orderId);
    return { id: orderId, status: input.status };
  });
  response.json(updated);
});

router.post("/orders/:id/complete", authenticate, requireCompany("customer"), requireRole("owner", "admin", "manager", "purchaser"), async (request, response) => {
  const orderId = parse(uuidSchema, request.params.id);
  const input = parse(z.object({ confirmReceipt: z.literal(true) }), request.body);
  const context = request.context!;
  const completed = await transaction(async (client) => {
    const order = await client.query<{ status: string }>(
      "SELECT status FROM orders WHERE id = $1 AND customer_company_id = $2 FOR UPDATE",
      [orderId, context.companyId],
    );
    const record = order.rows[0];
    invariant(record && record.status !== "cancelled", 404, "أمر الشراء غير موجود أو ملغى.", "ORDER_NOT_FOUND");
    invariant(["confirmed", "processing", "partially_fulfilled"].includes(record.status), 409, "لا يمكن إكمال أمر الشراء في حالته الحالية.", "ORDER_NOT_COMPLETABLE");
    const shipments = await client.query<{ total: number; delivered: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'delivered')::int AS delivered
       FROM shipments WHERE order_id = $1`,
      [orderId],
    );
    invariant(shipments.rows[0]!.total > 0 && shipments.rows[0]!.total === shipments.rows[0]!.delivered,
      409, "لا يمكن إغلاق الطلب حتى تُسلّم كل الشحنات المرتبطة وتُسجل إثباتات التسليم.", "SHIPMENTS_NOT_DELIVERED");
    await client.query("UPDATE orders SET status = 'fulfilled' WHERE id = $1", [orderId]);
    await client.query(
      `UPDATE managed_replenishments SET status = 'awaiting_stock', updated_at = now()
       WHERE order_id = $1 AND status = 'ordered'`,
      [orderId],
    );
    await audit(client, context.companyId, context.userId, "order.receipt.confirmed", "order", orderId, { confirmed: input.confirmReceipt });
    return { id: orderId, status: "fulfilled" };
  });
  response.json(completed);
});

export default router;

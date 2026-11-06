import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { authenticate, requireCompany, requireRole } from "./auth.js";
import { audit, ensureCompanyActive, query, transaction } from "./db.js";
import { ApiError, invariant } from "./errors.js";
import { parse, textSchema, uuidSchema } from "./validation.js";

const router = Router();
const managerRoles = ["owner", "admin", "manager"] as const;
const moneySchema = z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/, "أدخل مبلغًا صحيحًا بمنزلتين عشريتين كحد أقصى.");

function toCents(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
}

function fromCents(value: bigint): string {
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

function reference(prefix: string): string {
  return `${prefix}-${new Date().getFullYear()}-${randomBytes(8).toString("hex").toUpperCase()}`;
}

router.get("/contracts", authenticate, async (request, response) => {
  const result = await query(
    `SELECT c.id, c.reference, c.customer_company_id AS "customerCompanyId",
            c.counterparty_company_id AS "counterpartyCompanyId", c.title, c.terms, c.status,
            c.starts_on AS "startsOn", c.ends_on AS "endsOn", c.created_at AS "createdAt",
            customer.display_name AS "customerName", partner.display_name AS "counterpartyName",
            (SELECT count(*)::int FROM contract_signatures s WHERE s.contract_id = c.id) AS "signatureCount"
     FROM contracts c JOIN companies customer ON customer.id = c.customer_company_id
     JOIN companies partner ON partner.id = c.counterparty_company_id
     WHERE c.customer_company_id = $1 OR c.counterparty_company_id = $1
     ORDER BY c.created_at DESC LIMIT 200`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.post("/contracts", authenticate, requireCompany("customer"), requireRole(...managerRoles, "purchaser"), async (request, response) => {
  const input = parse(z.object({
    counterpartyCompanyId: uuidSchema,
    title: textSchema(3, 200),
    terms: textSchema(10, 20_000),
    orderId: uuidSchema.optional(),
    startsOn: z.iso.date().optional(),
    endsOn: z.iso.date().optional(),
  }).strict(), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  if (input.startsOn && input.endsOn) {
    invariant(input.endsOn >= input.startsOn, 400, "تاريخ انتهاء العقد يسبق تاريخ بدايته.");
  }
  const created = await transaction(async (client) => {
    const company = await client.query(
      `SELECT 1 FROM companies WHERE id = $1 AND type IN ('supplier', 'service_provider', 'logistics_provider') AND status = 'active'`,
      [input.counterpartyCompanyId],
    );
    invariant(company.rowCount === 1, 404, "الطرف المقابل غير متاح.", "COUNTERPARTY_NOT_FOUND");
    if (input.orderId) {
      const order = await client.query("SELECT 1 FROM orders WHERE id = $1 AND customer_company_id = $2", [input.orderId, context.companyId]);
      invariant(order.rowCount === 1, 404, "أمر الشراء غير موجود في شركتك.", "ORDER_NOT_FOUND");
    }
    const contract = await client.query(
      `INSERT INTO contracts (reference, customer_company_id, counterparty_company_id, order_id, title, terms, starts_on, ends_on, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, reference, title, terms, status, starts_on AS "startsOn", ends_on AS "endsOn", created_at AS "createdAt"`,
      [reference("CON"), context.companyId, input.counterpartyCompanyId, input.orderId ?? null, input.title, input.terms,
        input.startsOn ?? null, input.endsOn ?? null, context.userId],
    );
    await audit(client, context.companyId, context.userId, "contract.created", "contract", contract.rows[0].id);
    return contract.rows[0];
  });
  response.status(201).json(created);
});

router.post("/contracts/:id/sign", authenticate, requireRole(...managerRoles), async (request, response) => {
  const contractId = parse(uuidSchema, request.params.id);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const signed = await transaction(async (client) => {
    const contract = await client.query<{ customer_company_id: string; counterparty_company_id: string; status: string }>(
      "SELECT customer_company_id, counterparty_company_id, status FROM contracts WHERE id = $1 FOR UPDATE",
      [contractId],
    );
    const record = contract.rows[0];
    invariant(record && (record.customer_company_id === context.companyId || record.counterparty_company_id === context.companyId), 404, "العقد غير موجود لشركتك.", "CONTRACT_NOT_FOUND");
    invariant(["draft", "pending_approval"].includes(record.status), 409, "العقد غير قابل للتوقيع في حالته الحالية.", "CONTRACT_NOT_SIGNABLE");
    await client.query(
      `INSERT INTO contract_signatures (contract_id, company_id, signed_by)
       VALUES ($1, $2, $3) ON CONFLICT (contract_id, company_id) DO NOTHING`,
      [contractId, context.companyId, context.userId],
    );
    const signatures = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM contract_signatures WHERE contract_id = $1",
      [contractId],
    );
    const status = signatures.rows[0]!.count === 2 ? "active" : "pending_approval";
    await client.query("UPDATE contracts SET status = $1 WHERE id = $2", [status, contractId]);
    await audit(client, context.companyId, context.userId, "contract.signed", "contract", contractId, { status });
    return { id: contractId, status, signatures: signatures.rows[0]!.count };
  });
  response.json(signed);
});

router.post("/contracts/:id/terminate", authenticate, requireRole(...managerRoles), async (request, response) => {
  const contractId = parse(uuidSchema, request.params.id);
  const context = request.context!;
  const changed = await transaction(async (client) => {
    const result = await client.query(
      `UPDATE contracts SET status = 'terminated'
       WHERE id = $1 AND (customer_company_id = $2 OR counterparty_company_id = $2) AND status = 'active'
       RETURNING id, status`,
      [contractId, context.companyId],
    );
    invariant(result.rows[0], 404, "العقد غير موجود أو غير نشط.", "CONTRACT_NOT_ACTIVE");
    await audit(client, context.companyId, context.userId, "contract.terminated", "contract", contractId);
    return result.rows[0];
  });
  response.json(changed);
});

router.get("/invoices", authenticate, async (request, response) => {
  const result = await query(
    `SELECT i.id, i.reference, i.issuer_company_id AS "issuerCompanyId",
            i.customer_company_id AS "customerCompanyId", i.order_id AS "orderId",
            i.status, i.currency, i.subtotal, i.tax_amount AS "taxAmount", i.total_amount AS "totalAmount",
            i.due_on AS "dueOn", i.issued_at AS "issuedAt", i.created_at AS "createdAt",
            issuer.display_name AS "issuerName", customer.display_name AS "customerName",
            COALESCE((SELECT sum(p.amount) FROM invoice_payments p WHERE p.invoice_id = i.id), 0) AS "paidAmount"
     FROM invoices i JOIN companies issuer ON issuer.id = i.issuer_company_id
     JOIN companies customer ON customer.id = i.customer_company_id
     WHERE i.issuer_company_id = $1 OR i.customer_company_id = $1
     ORDER BY i.created_at DESC LIMIT 200`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.post("/invoices", authenticate, requireCompany("supplier", "service_provider", "logistics_provider", "operator"), requireRole(...managerRoles, "accountant"), async (request, response) => {
  const input = parse(z.object({
    customerCompanyId: uuidSchema,
    orderId: uuidSchema.optional(),
    subtotal: moneySchema,
    taxAmount: moneySchema.default("0.00"),
    dueOn: z.iso.date().optional(),
  }).strict(), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const subtotalCents = toCents(input.subtotal);
  const taxCents = toCents(input.taxAmount);
  const created = await transaction(async (client) => {
    const customer = await client.query(
      "SELECT 1 FROM companies WHERE id = $1 AND type = 'customer' AND status = 'active'",
      [input.customerCompanyId],
    );
    invariant(customer.rowCount === 1, 404, "الشركة المستفيدة غير متاحة.", "CUSTOMER_NOT_FOUND");
    if (input.orderId) {
      const order = await client.query(
        `SELECT 1 FROM orders WHERE id = $1 AND status <> 'cancelled'
         AND ((customer_company_id = $2 AND supplier_company_id = $3) OR (customer_company_id = $3 AND supplier_company_id = $2))`,
        [input.orderId, input.customerCompanyId, context.companyId],
      );
      invariant(order.rowCount === 1, 404, "الطلب التجاري غير مرتبط بالطرفين.", "ORDER_NOT_FOUND");
    }
    const invoice = await client.query(
      `INSERT INTO invoices (reference, issuer_company_id, customer_company_id, order_id, subtotal, tax_amount, total_amount, due_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, reference, status, subtotal, tax_amount AS "taxAmount", total_amount AS "totalAmount", due_on AS "dueOn"`,
      [reference("INV"), context.companyId, input.customerCompanyId, input.orderId ?? null,
        fromCents(subtotalCents), fromCents(taxCents), fromCents(subtotalCents + taxCents), input.dueOn ?? null],
    );
    await audit(client, context.companyId, context.userId, "invoice.created", "invoice", invoice.rows[0].id);
    return invoice.rows[0];
  });
  response.status(201).json(created);
});

router.post("/invoices/:id/issue", authenticate, requireCompany("supplier", "service_provider", "logistics_provider", "operator"), requireRole(...managerRoles, "accountant"), async (request, response) => {
  const invoiceId = parse(uuidSchema, request.params.id);
  const issued = await transaction(async (client) => {
    const result = await client.query(
      `UPDATE invoices SET status = 'issued', issued_at = now()
       WHERE id = $1 AND issuer_company_id = $2 AND status = 'draft'
       RETURNING id, reference, status, issued_at AS "issuedAt"`,
      [invoiceId, request.context!.companyId],
    );
    invariant(result.rows[0], 404, "الفاتورة غير موجودة أو صادرة بالفعل.", "INVOICE_NOT_DRAFT");
    await audit(client, request.context!.companyId, request.context!.userId, "invoice.issued", "invoice", invoiceId);
    return result.rows[0];
  });
  response.json(issued);
});

router.post("/invoices/:id/payments", authenticate, requireCompany("supplier", "service_provider", "logistics_provider", "operator"), requireRole(...managerRoles, "accountant"), async (request, response) => {
  const invoiceId = parse(uuidSchema, request.params.id);
  const input = parse(z.object({
    amount: moneySchema,
    method: z.enum(["bank_transfer", "external_payment_provider", "other"]),
    externalReference: textSchema(3, 160),
  }).strict(), request.body);
  const context = request.context!;
  const amountCents = toCents(input.amount);
  invariant(amountCents > 0n, 400, "يجب أن تكون الدفعة أكبر من صفر.");
  const payment = await transaction(async (client) => {
    const invoice = await client.query<{ total_amount: string; status: string }>(
      "SELECT total_amount, status FROM invoices WHERE id = $1 AND issuer_company_id = $2 FOR UPDATE",
      [invoiceId, context.companyId],
    );
    const record = invoice.rows[0];
    invariant(record && ["issued", "partially_paid", "overdue"].includes(record.status), 404, "الفاتورة غير متاحة لتسجيل دفعة.", "INVOICE_NOT_PAYABLE");
    const received = await client.query<{ amount: string }>(
      "SELECT COALESCE(sum(amount), 0)::text AS amount FROM invoice_payments WHERE invoice_id = $1",
      [invoiceId],
    );
    const totalCents = toCents(record.total_amount);
    const paidCents = toCents(received.rows[0]!.amount);
    invariant(paidCents + amountCents <= totalCents, 409, "قيمة الدفعة تتجاوز المبلغ المتبقي.", "OVERPAYMENT");
    const created = await client.query(
      `INSERT INTO invoice_payments (invoice_id, amount, method, external_reference, recorded_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, amount, method, external_reference AS "externalReference", received_at AS "receivedAt"`,
      [invoiceId, fromCents(amountCents), input.method, input.externalReference, context.userId],
    );
    const nextStatus = paidCents + amountCents === totalCents ? "paid" : "partially_paid";
    await client.query("UPDATE invoices SET status = $1 WHERE id = $2", [nextStatus, invoiceId]);
    await audit(client, context.companyId, context.userId, "invoice.payment.recorded", "invoice", invoiceId, {
      amount: fromCents(amountCents),
      externalReference: input.externalReference,
    });
    return { ...created.rows[0], invoiceStatus: nextStatus };
  });
  response.status(201).json(payment);
});

router.get("/subscriptions", authenticate, async (request, response) => {
  const result = await query(
    `SELECT id, plan_code AS "planCode", status, price_monthly AS "priceMonthly", currency,
            starts_at AS "startsAt", ends_at AS "endsAt"
     FROM subscriptions WHERE company_id = $1 ORDER BY starts_at DESC`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.post("/subscriptions", authenticate, requireRole(...managerRoles), async (request, response) => {
  const input = parse(z.object({
    planCode: z.enum(["customer_business", "inventory_basic", "inventory_business", "inventory_enterprise", "procurement", "logistics", "supplier_premium", "enterprise"]),
  }).strict(), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const subscription = await transaction(async (client) => {
    await client.query("SELECT id FROM companies WHERE id = $1 FOR UPDATE", [context.companyId]);
    const current = await client.query(
      "SELECT 1 FROM subscriptions WHERE company_id = $1 AND status IN ('trialing', 'active', 'past_due')",
      [context.companyId],
    );
    invariant(current.rowCount === 0, 409, "توجد باقة فعالة بالفعل. ألغها قبل طلب باقة أخرى.", "ACTIVE_SUBSCRIPTION_EXISTS");
    const created = await client.query(
      `INSERT INTO subscriptions (company_id, plan_code, status, price_monthly, starts_at, ends_at)
       VALUES ($1, $2, 'trialing', 0, now(), now() + interval '14 days')
       RETURNING id, plan_code AS "planCode", status, price_monthly AS "priceMonthly", starts_at AS "startsAt", ends_at AS "endsAt"`,
      [context.companyId, input.planCode],
    );
    await audit(client, context.companyId, context.userId, "subscription.trial_started", "subscription", created.rows[0].id);
    return created.rows[0];
  });
  response.status(201).json({ ...subscription, message: "تم تفعيل فترة تجريبية داخلية؛ لا توجد عملية تحصيل أو تجديد تلقائي." });
});

router.post("/subscriptions/:id/cancel", authenticate, requireRole(...managerRoles), async (request, response) => {
  const subscriptionId = parse(uuidSchema, request.params.id);
  const result = await query(
    `UPDATE subscriptions SET status = 'cancelled', ends_at = now()
     WHERE id = $1 AND company_id = $2 AND status IN ('trialing', 'active', 'past_due')
     RETURNING id, status, ends_at AS "endsAt"`,
    [subscriptionId, request.context!.companyId],
  );
  invariant(result.rows[0], 404, "الاشتراك غير موجود أو ملغى.", "SUBSCRIPTION_NOT_ACTIVE");
  response.json(result.rows[0]);
});

export default router;

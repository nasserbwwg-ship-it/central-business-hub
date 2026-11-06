import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { authenticate, requireCompany, requireOperator, requireRole } from "./auth.js";
import { audit, ensureCompanyActive, query, transaction } from "./db.js";
import { invariant } from "./errors.js";
import { evaluateManagedInventory } from "./managed-inventory.js";
import { parse, quantitySchema, uuidSchema } from "./validation.js";

const router = Router();
const managerRoles = ["owner", "admin", "manager"] as const;
const moneyAmount = z.coerce.number().finite().positive().max(1_000_000_000);

async function cancelPendingReplenishments(
  client: PoolClient,
  serviceId: string,
): Promise<void> {
  const pending = await client.query<{ rfq_id: string | null }>(
    `SELECT rfq_id FROM managed_replenishments
     WHERE service_id = $1 AND status IN ('pending_quote', 'requires_approval') FOR UPDATE`,
    [serviceId],
  );
  for (const replenishment of pending.rows) {
    if (!replenishment.rfq_id) continue;
    await client.query(
      "UPDATE rfqs SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status IN ('open', 'reviewing', 'partially_awarded')",
      [replenishment.rfq_id],
    );
    await client.query("UPDATE supplier_quotes SET status = 'withdrawn' WHERE rfq_id = $1 AND status = 'submitted'", [replenishment.rfq_id]);
  }
  await client.query(
    `UPDATE managed_replenishments SET status = 'cancelled', updated_at = now()
     WHERE service_id = $1 AND status IN ('pending_quote', 'requires_approval')`,
    [serviceId],
  );
}

async function cancelRulePendingReplenishments(client: PoolClient, ruleId: string): Promise<void> {
  const pending = await client.query<{ rfq_id: string | null }>(
    `SELECT rfq_id FROM managed_replenishments
     WHERE rule_id = $1 AND status IN ('pending_quote', 'requires_approval') FOR UPDATE`,
    [ruleId],
  );
  for (const replenishment of pending.rows) {
    if (!replenishment.rfq_id) continue;
    await client.query(
      "UPDATE rfqs SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status IN ('open', 'reviewing', 'partially_awarded')",
      [replenishment.rfq_id],
    );
    await client.query("UPDATE supplier_quotes SET status = 'withdrawn' WHERE rfq_id = $1 AND status = 'submitted'", [replenishment.rfq_id]);
  }
  await client.query(
    `UPDATE managed_replenishments SET status = 'cancelled', updated_at = now()
     WHERE rule_id = $1 AND status IN ('pending_quote', 'requires_approval')`,
    [ruleId],
  );
}

router.get("/managed-inventory/services", authenticate, requireCompany("customer"), async (request, response) => {
  const result = await query(
    `SELECT s.id, w.name AS name, s.warehouse_id AS "warehouseId", w.name AS "warehouseName", w.city AS "warehouseCity",
            s.status, s.auto_reorder AS "autoReorder", s.per_order_budget AS "perOrderBudget",
            s.monthly_budget AS "monthlyBudget", s.monthly_fee AS "monthlyFee",
            s.request_notes AS "requestNotes", s.quote_notes AS "quoteNotes",
            s.quoted_at AS "quotedAt", s.accepted_at AS "acceptedAt", s.created_at AS "createdAt"
     FROM managed_inventory_services s JOIN warehouses w ON w.id = s.warehouse_id
     WHERE s.company_id = $1 ORDER BY s.created_at DESC LIMIT 100`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.get("/managed-inventory/service-options", authenticate, requireCompany("customer"), async (request, response) => {
  const result = await query(
    `SELECT s.id, w.name AS name
     FROM managed_inventory_services s JOIN warehouses w ON w.id = s.warehouse_id
     WHERE s.company_id = $1 AND s.status IN ('requested', 'quoted', 'active', 'paused')
     ORDER BY s.created_at DESC`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.post("/managed-inventory/services", authenticate, requireCompany("customer"), requireRole(...managerRoles), async (request, response) => {
  const input = parse(z.object({
    warehouseId: uuidSchema,
    autoReorder: z.boolean().default(true),
    perOrderBudget: moneyAmount,
    monthlyBudget: moneyAmount,
    requestNotes: z.string().trim().max(2000).optional(),
  }).strict().superRefine((value, context) => {
    if (value.perOrderBudget > value.monthlyBudget) {
      context.addIssue({ code: "custom", path: ["perOrderBudget"], message: "يجب ألا يتجاوز سقف الطلب سقف الشهر." });
    }
  }), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const created = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.warehouseId]);
    const warehouse = await client.query(
      "SELECT 1 FROM warehouses WHERE id = $1 AND company_id = $2",
      [input.warehouseId, context.companyId],
    );
    invariant(warehouse.rowCount === 1, 404, "المستودع غير موجود في شركتك.", "WAREHOUSE_NOT_FOUND");
    const currentService = await client.query(
      `SELECT 1 FROM managed_inventory_services
       WHERE company_id = $1 AND warehouse_id = $2 AND status IN ('requested', 'quoted', 'active', 'paused')`,
      [context.companyId, input.warehouseId],
    );
    invariant(currentService.rowCount === 0, 409, "يوجد طلب أو خدمة قائمة لهذا المستودع بالفعل.", "MANAGED_SERVICE_EXISTS");
    const service = await client.query(
      `INSERT INTO managed_inventory_services
       (company_id, warehouse_id, status, auto_reorder, per_order_budget, monthly_budget, request_notes, created_by)
       VALUES ($1, $2, 'requested', $3, $4, $5, $6, $7)
       RETURNING id, warehouse_id AS "warehouseId", status, auto_reorder AS "autoReorder",
                 per_order_budget AS "perOrderBudget", monthly_budget AS "monthlyBudget",
                 created_at AS "createdAt"`,
      [context.companyId, input.warehouseId, input.autoReorder, input.perOrderBudget,
        input.monthlyBudget, input.requestNotes ?? null, context.userId],
    );
    await audit(client, context.companyId, context.userId, "managed_inventory.service.requested", "managed_inventory_service", service.rows[0]!.id, {
      warehouseId: input.warehouseId,
      autoReorder: input.autoReorder,
      perOrderBudget: input.perOrderBudget,
      monthlyBudget: input.monthlyBudget,
    });
    return service.rows[0];
  });
  response.status(201).json(created);
});

router.get("/managed-inventory/rules", authenticate, requireCompany("customer"), async (request, response) => {
  const result = await query(
    `SELECT r.id, r.service_id AS "serviceId", s.status AS "serviceStatus",
            r.inventory_product_id AS "inventoryProductId", p.name AS "productName", p.unit,
            r.supplier_company_id AS "supplierCompanyId", c.display_name AS "supplierName",
            r.reorder_below_quantity AS "reorderBelowQuantity", r.reorder_quantity AS "reorderQuantity",
            r.max_unit_price AS "maxUnitPrice", r.is_active AS "isActive", r.created_at AS "createdAt"
     FROM managed_inventory_rules r
     JOIN managed_inventory_services s ON s.id = r.service_id AND s.company_id = $1
     JOIN inventory_products p ON p.id = r.inventory_product_id
     JOIN companies c ON c.id = r.supplier_company_id
     ORDER BY r.created_at DESC LIMIT 300`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.post("/managed-inventory/rules", authenticate, requireCompany("customer"), requireRole(...managerRoles), async (request, response) => {
  const input = parse(z.object({
    serviceId: uuidSchema,
    inventoryProductId: uuidSchema,
    supplierCompanyId: uuidSchema,
    reorderBelowQuantity: z.coerce.number().finite().nonnegative().max(1_000_000_000),
    reorderQuantity: quantitySchema,
    maxUnitPrice: moneyAmount,
  }).strict(), request.body);
  const serviceId = input.serviceId;
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const rule = await transaction(async (client) => {
    const service = await client.query<{ status: string; warehouse_id: string }>(
      `SELECT status, warehouse_id FROM managed_inventory_services
       WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [serviceId, context.companyId],
    );
    const managedService = service.rows[0];
    invariant(managedService && ["requested", "quoted", "active", "paused"].includes(managedService.status),
      404, "طلب الخدمة غير موجود أو مغلق.", "MANAGED_SERVICE_NOT_FOUND");
    const product = await client.query<{
      source_product_id: string | null;
      name: string;
      unit: string;
      supplier_company_id: string;
      minimum_order_quantity: string;
    }>(
      `SELECT ip.source_product_id, ip.name, ip.unit, p.supplier_company_id, p.minimum_order_quantity
       FROM inventory_products ip
       LEFT JOIN products p ON p.id = ip.source_product_id AND p.is_active
       WHERE ip.id = $1 AND ip.company_id = $2 AND ip.is_active`,
      [input.inventoryProductId, context.companyId],
    );
    const inventoryProduct = product.rows[0];
    invariant(inventoryProduct, 404, "صنف المخزون غير موجود أو غير فعال.", "INVENTORY_PRODUCT_NOT_FOUND");
    invariant(inventoryProduct.source_product_id && inventoryProduct.supplier_company_id === input.supplierCompanyId,
      400, "اربط صنف المخزون بمنتج منشور من المورد الذي اخترته.", "SUPPLIER_PRODUCT_MISMATCH");
    invariant(input.reorderQuantity >= Number(inventoryProduct.minimum_order_quantity),
      400, "كمية إعادة التوريد أقل من الحد الأدنى للمورد.", "MINIMUM_ORDER_QUANTITY_NOT_MET");
    invariant(input.reorderQuantity > input.reorderBelowQuantity,
      400, "يجب أن تكون كمية إعادة التوريد أكبر من حد بدء الطلب.", "INVALID_REORDER_TARGET");
    const supplier = await client.query(
      "SELECT 1 FROM companies WHERE id = $1 AND type = 'supplier' AND status = 'active'",
      [input.supplierCompanyId],
    );
    invariant(supplier.rowCount === 1, 400, "اختر موردًا معتمدًا ونشطًا.", "INVALID_SUPPLIER");
    const currentRule = await client.query(
      "SELECT 1 FROM managed_inventory_rules WHERE service_id = $1 AND inventory_product_id = $2",
      [serviceId, input.inventoryProductId],
    );
    invariant(currentRule.rowCount === 0, 409, "تمت إضافة قاعدة إعادة توريد لهذا الصنف بالفعل.", "MANAGED_RULE_EXISTS");
    const inserted = await client.query(
      `INSERT INTO managed_inventory_rules
       (service_id, inventory_product_id, supplier_company_id, reorder_below_quantity, reorder_quantity, max_unit_price)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, service_id AS "serviceId", inventory_product_id AS "inventoryProductId",
                 supplier_company_id AS "supplierCompanyId", reorder_below_quantity AS "reorderBelowQuantity",
                 reorder_quantity AS "reorderQuantity", max_unit_price AS "maxUnitPrice", is_active AS "isActive"`,
      [serviceId, input.inventoryProductId, input.supplierCompanyId, input.reorderBelowQuantity,
        input.reorderQuantity, input.maxUnitPrice],
    );
    await audit(client, context.companyId, context.userId, "managed_inventory.rule.created", "managed_inventory_rule", inserted.rows[0]!.id, {
      serviceId,
      inventoryProductId: input.inventoryProductId,
      supplierCompanyId: input.supplierCompanyId,
    });
    if (managedService.status === "active") {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [managedService.warehouse_id]);
      await evaluateManagedInventory(client, context.companyId, managedService.warehouse_id, context.userId, input.inventoryProductId);
    }
    return inserted.rows[0];
  });
  response.status(201).json(rule);
});

router.patch("/managed-inventory/rules/:id", authenticate, requireCompany("customer"), requireRole(...managerRoles), async (request, response) => {
  const ruleId = parse(uuidSchema, request.params.id);
  const input = parse(z.object({
    supplierCompanyId: uuidSchema.optional(),
    reorderBelowQuantity: z.coerce.number().finite().nonnegative().max(1_000_000_000).optional(),
    reorderQuantity: quantitySchema.optional(),
    maxUnitPrice: moneyAmount.optional(),
    isActive: z.boolean().optional(),
  }).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: "أدخل قيمة واحدة على الأقل لتعديل القاعدة.",
  }), request.body);
  const context = request.context!;
  const updated = await transaction(async (client) => {
    const current = await client.query<{
      service_id: string;
      service_status: string;
      warehouse_id: string;
      inventory_product_id: string;
      source_product_id: string | null;
      supplier_company_id: string;
      reorder_below_quantity: string;
      reorder_quantity: string;
      max_unit_price: string;
      is_active: boolean;
    }>(
      `SELECT r.service_id, s.status AS service_status, s.warehouse_id, r.inventory_product_id,
              p.source_product_id, r.supplier_company_id, r.reorder_below_quantity,
              r.reorder_quantity, r.max_unit_price, r.is_active
       FROM managed_inventory_rules r
       JOIN managed_inventory_services s ON s.id = r.service_id AND s.company_id = $2
       JOIN inventory_products p ON p.id = r.inventory_product_id AND p.company_id = s.company_id
       WHERE r.id = $1 FOR UPDATE OF r, s`,
      [ruleId, context.companyId],
    );
    const record = current.rows[0];
    invariant(record && ["requested", "quoted", "active", "paused"].includes(record.service_status),
      404, "قاعدة إعادة التوريد غير موجودة أو مغلقة.", "MANAGED_RULE_NOT_FOUND");
    const supplierCompanyId = input.supplierCompanyId ?? record.supplier_company_id;
    const reorderBelowQuantity = input.reorderBelowQuantity ?? Number(record.reorder_below_quantity);
    const reorderQuantity = input.reorderQuantity ?? Number(record.reorder_quantity);
    const isActive = input.isActive ?? record.is_active;
    invariant(reorderQuantity > reorderBelowQuantity, 400,
      "يجب أن تكون كمية إعادة التوريد أكبر من حد بدء الطلب.", "INVALID_REORDER_TARGET");
    const supplierProduct = await client.query<{ supplier_company_id: string; minimum_order_quantity: string }>(
      `SELECT supplier_company_id, minimum_order_quantity FROM products
       WHERE id = $1 AND is_active`,
      [record.source_product_id],
    );
    invariant(record.source_product_id && supplierProduct.rows[0]?.supplier_company_id === supplierCompanyId,
      400, "اربط صنف المخزون بمنتج فعال من المورد المحدد.", "SUPPLIER_PRODUCT_MISMATCH");
    invariant(reorderQuantity >= Number(supplierProduct.rows[0]!.minimum_order_quantity),
      400, "كمية إعادة التوريد أقل من الحد الأدنى للمورد.", "MINIMUM_ORDER_QUANTITY_NOT_MET");
    const supplier = await client.query(
      "SELECT 1 FROM companies WHERE id = $1 AND type = 'supplier' AND status = 'active'",
      [supplierCompanyId],
    );
    invariant(supplier.rowCount === 1, 400, "اختر موردًا معتمدًا ونشطًا.", "INVALID_SUPPLIER");

    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [record.warehouse_id]);
    await cancelRulePendingReplenishments(client, ruleId);
    const result = await client.query(
      `UPDATE managed_inventory_rules
       SET supplier_company_id = $1, reorder_below_quantity = $2, reorder_quantity = $3,
           max_unit_price = $4, is_active = $5
       WHERE id = $6
       RETURNING id, service_id AS "serviceId", inventory_product_id AS "inventoryProductId",
                 supplier_company_id AS "supplierCompanyId", reorder_below_quantity AS "reorderBelowQuantity",
                 reorder_quantity AS "reorderQuantity", max_unit_price AS "maxUnitPrice",
                 is_active AS "isActive"`,
      [supplierCompanyId, reorderBelowQuantity, reorderQuantity, input.maxUnitPrice ?? record.max_unit_price,
        isActive, ruleId],
    );
    if (isActive) {
      await client.query(
        `UPDATE managed_replenishments SET status = 'fulfilled', updated_at = now()
         WHERE rule_id = $1 AND status = 'cancelled' AND order_id IS NULL`,
        [ruleId],
      );
    }
    await audit(client, context.companyId, context.userId, "managed_inventory.rule.updated", "managed_inventory_rule", ruleId, {
      serviceId: record.service_id,
      ...input,
    });
    if (record.service_status === "active" && isActive) {
      await evaluateManagedInventory(client, context.companyId, record.warehouse_id, context.userId, record.inventory_product_id);
    }
    return result.rows[0];
  });
  response.json(updated);
});

router.get("/managed-inventory/replenishments", authenticate, requireCompany("customer"), async (request, response) => {
  const result = await query(
    `SELECT mr.id, mr.status, mr.current_quantity AS "currentQuantity",
            mr.requested_quantity AS "requestedQuantity", mr.authorized_amount AS "authorizedAmount",
            mr.block_reason AS "blockReason", mr.created_at AS "createdAt",
            w.name AS "warehouseName", p.name AS "productName", p.unit,
            f.reference AS "rfqReference", o.reference AS "orderReference"
     FROM managed_replenishments mr
     JOIN managed_inventory_services s ON s.id = mr.service_id AND s.company_id = $1
     JOIN managed_inventory_rules r ON r.id = mr.rule_id
     JOIN warehouses w ON w.id = s.warehouse_id
     JOIN inventory_products p ON p.id = r.inventory_product_id
     LEFT JOIN rfqs f ON f.id = mr.rfq_id
     LEFT JOIN orders o ON o.id = mr.order_id
     ORDER BY mr.created_at DESC LIMIT 200`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.post("/managed-inventory/services/:id/accept", authenticate, requireCompany("customer"), requireRole(...managerRoles), async (request, response) => {
  const serviceId = parse(uuidSchema, request.params.id);
  const context = request.context!;
  const activated = await transaction(async (client) => {
    const service = await client.query<{ warehouse_id: string; auto_reorder: boolean }>(
      `SELECT warehouse_id, auto_reorder FROM managed_inventory_services
       WHERE id = $1 AND company_id = $2 AND status = 'quoted' FOR UPDATE`,
      [serviceId, context.companyId],
    );
    const record = service.rows[0];
    invariant(record, 404, "عرض الاشتراك غير موجود أو سبق البت فيه.", "MANAGED_SERVICE_QUOTE_NOT_FOUND");
    const rules = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM managed_inventory_rules WHERE service_id = $1 AND is_active",
      [serviceId],
    );
    invariant(rules.rows[0]!.count > 0, 409,
      "أضف صنفًا واحدًا على الأقل وحدد المورد والكميات والسقوف قبل تفعيل الخدمة.", "MANAGED_SERVICE_RULES_REQUIRED");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [record.warehouse_id]);
    const result = await client.query(
      `UPDATE managed_inventory_services SET status = 'active', accepted_at = now(), updated_at = now()
       WHERE id = $1 AND company_id = $2
       RETURNING id, status, monthly_fee AS "monthlyFee", accepted_at AS "acceptedAt"`,
      [serviceId, context.companyId],
    );
    await audit(client, context.companyId, context.userId, "managed_inventory.service.activated", "managed_inventory_service", serviceId);
    await evaluateManagedInventory(client, context.companyId, record.warehouse_id, context.userId);
    return result.rows[0];
  });
  response.json(activated);
});

router.post("/managed-inventory/services/:id/resume", authenticate, requireCompany("customer"), requireRole(...managerRoles), async (request, response) => {
  const serviceId = parse(uuidSchema, request.params.id);
  const context = request.context!;
  const resumed = await transaction(async (client) => {
    const service = await client.query<{ warehouse_id: string }>(
      `SELECT warehouse_id FROM managed_inventory_services
       WHERE id = $1 AND company_id = $2 AND status = 'paused' FOR UPDATE`,
      [serviceId, context.companyId],
    );
    invariant(service.rows[0], 404, "الخدمة غير متوقفة مؤقتًا أو لا تخص شركتك.", "MANAGED_SERVICE_NOT_PAUSED");
    const rules = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM managed_inventory_rules WHERE service_id = $1 AND is_active",
      [serviceId],
    );
    invariant(rules.rows[0]!.count > 0, 409, "أضف حدود توريد فعالة قبل استئناف الخدمة.", "MANAGED_SERVICE_RULES_REQUIRED");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [service.rows[0].warehouse_id]);
    await client.query(
      `UPDATE managed_replenishments SET status = 'fulfilled', updated_at = now()
       WHERE service_id = $1 AND status = 'cancelled' AND order_id IS NULL`,
      [serviceId],
    );
    const result = await client.query(
      `UPDATE managed_inventory_services SET status = 'active', updated_at = now()
       WHERE id = $1 AND company_id = $2
       RETURNING id, status`,
      [serviceId, context.companyId],
    );
    await audit(client, context.companyId, context.userId, "managed_inventory.service.resumed", "managed_inventory_service", serviceId);
    await evaluateManagedInventory(client, context.companyId, service.rows[0].warehouse_id, context.userId);
    return result.rows[0];
  });
  response.json(resumed);
});

router.post("/managed-inventory/services/:id/cancel", authenticate, requireCompany("customer"), requireRole(...managerRoles), async (request, response) => {
  const serviceId = parse(uuidSchema, request.params.id);
  const context = request.context!;
  const cancelled = await transaction(async (client) => {
    const service = await client.query<{ warehouse_id: string }>(
      `SELECT warehouse_id FROM managed_inventory_services
       WHERE id = $1 AND company_id = $2 AND status IN ('requested', 'quoted', 'active', 'paused')
       FOR UPDATE`,
      [serviceId, context.companyId],
    );
    invariant(service.rows[0], 404, "طلب الخدمة غير موجود أو مغلق.", "MANAGED_SERVICE_NOT_CANCELLABLE");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [service.rows[0].warehouse_id]);
    const result = await client.query(
      `UPDATE managed_inventory_services SET status = 'cancelled', updated_at = now()
       WHERE id = $1 AND company_id = $2 AND status IN ('requested', 'quoted', 'active', 'paused')
       RETURNING id, status`,
      [serviceId, context.companyId],
    );
    invariant(result.rows[0], 404, "طلب الخدمة غير موجود أو مغلق.", "MANAGED_SERVICE_NOT_CANCELLABLE");
    await cancelPendingReplenishments(client, serviceId);
    await audit(client, context.companyId, context.userId, "managed_inventory.service.cancelled", "managed_inventory_service", serviceId);
    return result.rows[0];
  });
  response.json(cancelled);
});

router.get("/admin/managed-inventory", authenticate, requireOperator, requireRole("owner"), async (_request, response) => {
  const result = await query(
    `SELECT s.id, s.status, s.auto_reorder AS "autoReorder",
            s.per_order_budget AS "perOrderBudget", s.monthly_budget AS "monthlyBudget",
            s.monthly_fee AS "monthlyFee", s.request_notes AS "requestNotes",
            s.quote_notes AS "quoteNotes", s.created_at AS "createdAt",
            c.display_name AS "customerName", w.name AS "warehouseName", w.city AS "warehouseCity",
            (SELECT count(*)::int FROM managed_inventory_rules r WHERE r.service_id = s.id AND r.is_active) AS "ruleCount",
            (SELECT string_agg(p.name || ' (' || r.reorder_quantity || ' ' || p.unit || ')', '، ' ORDER BY p.name)
             FROM managed_inventory_rules r
             JOIN inventory_products p ON p.id = r.inventory_product_id
             WHERE r.service_id = s.id AND r.is_active) AS "scopeSummary"
     FROM managed_inventory_services s
     JOIN companies c ON c.id = s.company_id
     JOIN warehouses w ON w.id = s.warehouse_id
     ORDER BY s.created_at DESC LIMIT 300`,
  );
  response.json({ data: result.rows });
});

router.patch("/admin/managed-inventory/:id/quote", authenticate, requireOperator, requireRole("owner"), async (request, response) => {
  const serviceId = parse(uuidSchema, request.params.id);
  const input = parse(z.object({
    monthlyFee: z.coerce.number().finite().nonnegative().max(1_000_000_000),
    quoteNotes: z.string().trim().min(2).max(2000),
  }).strict(), request.body);
  const context = request.context!;
  const quoted = await transaction(async (client) => {
    const rules = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM managed_inventory_rules r JOIN managed_inventory_services s ON s.id = r.service_id
       WHERE s.id = $1 AND s.status = 'requested' AND r.is_active`,
      [serviceId],
    );
    const ruleCount = rules.rows[0]?.count ?? 0;
    invariant(ruleCount > 0, 409, "لا يمكن تسعير الخدمة قبل تحديد أصناف وموردين وقواعد إعادة التوريد.", "MANAGED_SERVICE_RULES_REQUIRED");
    const result = await client.query(
      `UPDATE managed_inventory_services SET status = 'quoted', monthly_fee = $1,
         quote_notes = $2, quoted_at = now(), updated_at = now()
       WHERE id = $3 AND status = 'requested'
       RETURNING id, company_id AS "companyId", status, monthly_fee AS "monthlyFee",
                 quote_notes AS "quoteNotes", quoted_at AS "quotedAt"`,
      [input.monthlyFee, input.quoteNotes, serviceId],
    );
    const quote = result.rows[0];
    invariant(quote, 404, "طلب الاشتراك غير موجود أو سبق تسعيره.", "MANAGED_SERVICE_NOT_REQUESTED");
    await audit(client, context.companyId, context.userId, "managed_inventory.service.quoted", "managed_inventory_service", serviceId, {
      customerCompanyId: quote.companyId,
      monthlyFee: input.monthlyFee,
    });
    return quote;
  });
  response.json(quoted);
});

router.patch("/admin/managed-inventory/:id/status", authenticate, requireOperator, requireRole("owner"), async (request, response) => {
  const serviceId = parse(uuidSchema, request.params.id);
  const input = parse(z.object({ status: z.enum(["rejected", "paused"]) }).strict(), request.body);
  const context = request.context!;
  const changed = await transaction(async (client) => {
    const service = await client.query<{ warehouse_id: string }>(
      `SELECT warehouse_id FROM managed_inventory_services
       WHERE id = $1 AND status = ANY($2::text[]) FOR UPDATE`,
      [serviceId, input.status === "paused" ? ["active"] : ["requested", "quoted"]],
    );
    invariant(service.rows[0], 409, "لا يمكن تغيير حالة طلب الخدمة من وضعه الحالي.", "MANAGED_SERVICE_STATUS_INVALID");
    if (input.status === "paused") {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [service.rows[0].warehouse_id]);
    }
    const allowedFrom = input.status === "rejected" ? ["requested", "quoted"] : ["active"];
    const result = await client.query(
      `UPDATE managed_inventory_services SET status = $1, updated_at = now()
       WHERE id = $2 AND status = ANY($3::text[])
       RETURNING id, company_id AS "companyId", status`,
      [input.status, serviceId, allowedFrom],
    );
    const updated = result.rows[0];
    invariant(updated, 409, "لا يمكن تغيير حالة طلب الخدمة من وضعه الحالي.", "MANAGED_SERVICE_STATUS_INVALID");
    if (input.status === "paused") await cancelPendingReplenishments(client, serviceId);
    await audit(client, context.companyId, context.userId, `managed_inventory.service.${input.status}`, "managed_inventory_service", serviceId, {
      customerCompanyId: updated.companyId,
    });
    return updated;
  });
  response.json(changed);
});

router.get("/admin/managed-inventory/replenishments", authenticate, requireOperator, requireRole("owner"), async (_request, response) => {
  const result = await query(
    `SELECT mr.id, mr.status, mr.current_quantity AS "currentQuantity",
            mr.requested_quantity AS "requestedQuantity", mr.authorized_amount AS "authorizedAmount",
            mr.block_reason AS "blockReason", mr.created_at AS "createdAt",
            c.display_name AS "customerName", w.name AS "warehouseName", p.name AS "productName", p.unit,
            f.reference AS "rfqReference", o.reference AS "orderReference"
     FROM managed_replenishments mr
     JOIN managed_inventory_services s ON s.id = mr.service_id
     JOIN companies c ON c.id = s.company_id
     JOIN managed_inventory_rules r ON r.id = mr.rule_id
     JOIN inventory_products p ON p.id = r.inventory_product_id
     JOIN warehouses w ON w.id = s.warehouse_id
     LEFT JOIN rfqs f ON f.id = mr.rfq_id
     LEFT JOIN orders o ON o.id = mr.order_id
     ORDER BY mr.created_at DESC LIMIT 300`,
  );
  response.json({ data: result.rows });
});

export default router;

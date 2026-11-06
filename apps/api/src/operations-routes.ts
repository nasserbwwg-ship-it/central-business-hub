import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { authenticate, requireCompany, requireRole } from "./auth.js";
import { audit, ensureCompanyActive, query, transaction } from "./db.js";
import { ApiError, invariant } from "./errors.js";
import { evaluateManagedInventory } from "./managed-inventory.js";
import { parse, quantitySchema, textSchema, uuidSchema } from "./validation.js";

const router = Router();
const managerRoles = ["owner", "admin", "manager"] as const;
const stockTypes = ["receipt", "issue", "adjustment"] as const;
const temperatureSchema = z.enum(["ambient", "chilled", "frozen"]);

router.get("/logistics/profile", authenticate, requireCompany("logistics_provider"), async (request, response) => {
  const result = await query(
    `SELECT coverage_cities AS "coverageCities", transport_types AS "transportTypes",
            temperature_capabilities AS "temperatureCapabilities", max_payload_kg AS "maxPayloadKg",
            updated_at AS "updatedAt"
     FROM carrier_profiles WHERE company_id = $1`,
    [request.context!.companyId],
  );
  response.json(result.rows[0] ?? null);
});

router.put("/logistics/profile", authenticate, requireCompany("logistics_provider"), requireRole(...managerRoles), async (request, response) => {
  const input = parse(z.object({
    coverageCities: z.array(textSchema(2, 100)).min(1).max(100),
    transportTypes: z.array(z.enum(["road", "refrigerated", "frozen", "express"])).min(1).max(10),
    temperatureCapabilities: z.array(temperatureSchema).min(1).max(3),
    maxPayloadKg: z.coerce.number().finite().positive().max(1_000_000).nullable().optional(),
  }).strict(), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const profile = await query(
    `INSERT INTO carrier_profiles (company_id, coverage_cities, transport_types, temperature_capabilities, max_payload_kg, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (company_id) DO UPDATE SET coverage_cities = EXCLUDED.coverage_cities,
       transport_types = EXCLUDED.transport_types, temperature_capabilities = EXCLUDED.temperature_capabilities,
       max_payload_kg = EXCLUDED.max_payload_kg, updated_at = now()
     RETURNING coverage_cities AS "coverageCities", transport_types AS "transportTypes",
               temperature_capabilities AS "temperatureCapabilities", max_payload_kg AS "maxPayloadKg",
               updated_at AS "updatedAt"`,
    [context.companyId, [...new Set(input.coverageCities)], [...new Set(input.transportTypes)],
      [...new Set(input.temperatureCapabilities)], input.maxPayloadKg ?? null],
  );
  response.json(profile.rows[0]);
});

router.get("/logistics/vehicles", authenticate, requireCompany("logistics_provider"), async (request, response) => {
  const result = await query(
    `SELECT id, vehicle_type AS "vehicleType", plate_number AS "plateNumber",
            max_payload_kg AS "maxPayloadKg", temperature_capabilities AS "temperatureCapabilities",
            is_active AS "isActive", created_at AS "createdAt"
     FROM carrier_vehicles WHERE company_id = $1 ORDER BY created_at DESC`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.post("/logistics/vehicles", authenticate, requireCompany("logistics_provider"), requireRole(...managerRoles), async (request, response) => {
  const input = parse(z.object({
    vehicleType: textSchema(2, 80),
    plateNumber: textSchema(2, 30).transform((value) => value.toUpperCase()),
    maxPayloadKg: z.coerce.number().finite().positive().max(1_000_000),
    temperatureCapabilities: z.array(temperatureSchema).min(1).max(3),
  }).strict(), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const result = await query(
    `INSERT INTO carrier_vehicles (company_id, vehicle_type, plate_number, max_payload_kg, temperature_capabilities)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, vehicle_type AS "vehicleType", plate_number AS "plateNumber",
               max_payload_kg AS "maxPayloadKg", temperature_capabilities AS "temperatureCapabilities",
               is_active AS "isActive"`,
    [context.companyId, input.vehicleType, input.plateNumber, input.maxPayloadKg, [...new Set(input.temperatureCapabilities)]],
  );
  response.status(201).json(result.rows[0]);
});

router.patch("/logistics/vehicles/:id", authenticate, requireCompany("logistics_provider"), requireRole(...managerRoles), async (request, response) => {
  const vehicleId = parse(uuidSchema, request.params.id);
  const input = parse(z.object({ isActive: z.boolean() }).strict(), request.body);
  const result = await query(
    `UPDATE carrier_vehicles SET is_active = $1 WHERE id = $2 AND company_id = $3
     RETURNING id, vehicle_type AS "vehicleType", plate_number AS "plateNumber", is_active AS "isActive"`,
    [input.isActive, vehicleId, request.context!.companyId],
  );
  invariant(result.rows[0], 404, "المركبة غير موجودة في شركة النقل.", "VEHICLE_NOT_FOUND");
  response.json(result.rows[0]);
});

router.get("/logistics/drivers", authenticate, requireCompany("logistics_provider"), async (request, response) => {
  const result = await query(
    `SELECT u.id, u.full_name AS "fullName", u.email
     FROM company_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.company_id = $1 AND m.role = 'driver' AND u.is_active ORDER BY u.full_name`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.get("/logistics/carriers", authenticate, requireCompany("customer"), async (request, response) => {
  const input = parse(z.object({
    pickupCity: textSchema(2, 100),
    deliveryCity: textSchema(2, 100),
    temperature: temperatureSchema.default("ambient"),
    weightKg: z.coerce.number().positive().max(1_000_000).optional(),
  }), request.query);
  const result = await query(
    `SELECT c.id, c.display_name AS "displayName", p.transport_types AS "transportTypes",
            p.max_payload_kg AS "maxPayloadKg",
            count(DISTINCT v.id)::int AS "availableVehicles"
     FROM carrier_profiles p JOIN companies c ON c.id = p.company_id
     LEFT JOIN carrier_vehicles v ON v.company_id = c.id AND v.is_active
       AND $3 = ANY(v.temperature_capabilities)
       AND ($4::numeric IS NULL OR v.max_payload_kg >= $4)
     WHERE c.status = 'active' AND $1 = ANY(p.coverage_cities) AND $2 = ANY(p.coverage_cities)
       AND $3 = ANY(p.temperature_capabilities)
       AND (p.max_payload_kg IS NULL OR $4::numeric IS NULL OR p.max_payload_kg >= $4)
       AND v.id IS NOT NULL
     GROUP BY c.id, c.display_name, p.transport_types, p.max_payload_kg
     ORDER BY count(DISTINCT v.id) DESC, c.display_name`,
    [input.pickupCity, input.deliveryCity, input.temperature, input.weightKg ?? null],
  );
  response.json({ data: result.rows });
});

router.get("/inventory/warehouses", authenticate, async (request, response) => {
  const result = await query(
    `SELECT id, name, city, branch_id AS "branchId", created_at AS "createdAt"
     FROM warehouses WHERE company_id = $1 ORDER BY name`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.post("/inventory/warehouses", authenticate, requireCompany("customer"), requireRole(...managerRoles, "warehouse"), async (request, response) => {
  const input = parse(z.object({
    name: textSchema(2, 120),
    city: textSchema(2, 100),
    branchId: uuidSchema.optional(),
  }).strict(), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  if (input.branchId) {
    const branch = await query("SELECT 1 FROM branches WHERE id = $1 AND company_id = $2", [input.branchId, context.companyId]);
    invariant(branch.rowCount === 1, 404, "الفرع غير موجود في شركتك.", "BRANCH_NOT_FOUND");
  }
  const result = await query(
    `INSERT INTO warehouses (company_id, name, city, branch_id)
     VALUES ($1, $2, $3, $4) RETURNING id, name, city, branch_id AS "branchId", created_at AS "createdAt"`,
    [context.companyId, input.name, input.city, input.branchId ?? null],
  );
  response.status(201).json(result.rows[0]);
});

router.get("/inventory/products", authenticate, requireCompany("customer"), async (request, response) => {
  const barcode = typeof request.query.barcode === "string" ? request.query.barcode.trim().slice(0, 100) : "";
  const result = await query(
    `SELECT ip.id, ip.source_product_id AS "sourceProductId", ip.barcode, ip.name, ip.unit,
            supplier.display_name AS "sourceSupplierName",
            ip.low_stock_threshold AS "lowStockThreshold", ip.is_active AS "isActive", ip.created_at AS "createdAt"
     FROM inventory_products ip
     LEFT JOIN products p ON p.id = ip.source_product_id
     LEFT JOIN companies supplier ON supplier.id = p.supplier_company_id
     WHERE ip.company_id = $1 AND ip.is_active = true
       AND ($2 = '' OR ip.barcode = $2) ORDER BY ip.name LIMIT 500`,
    [request.context!.companyId, barcode],
  );
  response.json({ data: result.rows });
});

router.post("/inventory/products", authenticate, requireCompany("customer"), requireRole(...managerRoles, "warehouse"), async (request, response) => {
  const input = parse(z.object({
    sourceProductId: uuidSchema.optional(),
    barcode: z.string().trim().min(1).max(100).optional(),
    name: textSchema(1, 200),
    unit: textSchema(1, 40),
    lowStockThreshold: z.coerce.number().finite().nonnegative().max(1_000_000_000).default(0),
  }).strict(), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  if (input.sourceProductId) {
    const source = await query("SELECT 1 FROM products WHERE id = $1 AND is_active = true", [input.sourceProductId]);
    invariant(source.rowCount === 1, 404, "المنتج المرتبط غير متاح في الكتالوج.", "PRODUCT_NOT_FOUND");
  }
  const result = await transaction(async (client) => {
    const product = await client.query(
      `INSERT INTO inventory_products (company_id, source_product_id, barcode, name, unit, low_stock_threshold)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, source_product_id AS "sourceProductId", barcode, name, unit,
                 low_stock_threshold AS "lowStockThreshold", is_active AS "isActive"`,
      [context.companyId, input.sourceProductId ?? null, input.barcode || null, input.name, input.unit, input.lowStockThreshold],
    );
    await audit(client, context.companyId, context.userId, "inventory_product.created", "inventory_product", product.rows[0].id);
    return product.rows[0];
  });
  response.status(201).json(result);
});

router.get("/inventory/alerts", authenticate, requireCompany("customer"), async (request, response) => {
  const days = request.query.expiringWithinDays === undefined
    ? 30
    : parse(z.coerce.number().int().min(1).max(365), request.query.expiringWithinDays);
  const companyId = request.context!.companyId;
  const [lowStock, expiring] = await Promise.all([
    query(
      `SELECT b.warehouse_id AS "warehouseId", w.name AS "warehouseName", b.inventory_product_id AS "inventoryProductId",
              b.product_name AS "productName", b.unit, sum(b.quantity) AS quantity,
              ip.low_stock_threshold AS "lowStockThreshold"
       FROM inventory_balances b JOIN warehouses w ON w.id = b.warehouse_id
       JOIN inventory_products ip ON ip.id = b.inventory_product_id AND ip.company_id = b.company_id
       WHERE b.company_id = $1 AND ip.low_stock_threshold > 0
       GROUP BY b.warehouse_id, w.name, b.inventory_product_id, b.product_name, b.unit, ip.low_stock_threshold
       HAVING sum(b.quantity) <= ip.low_stock_threshold`,
      [companyId],
    ),
    query(
      `SELECT b.warehouse_id AS "warehouseId", w.name AS "warehouseName", b.product_name AS "productName",
              b.unit, b.batch_number AS "batchNumber", b.expires_on AS "expiresOn", b.quantity
       FROM inventory_balances b JOIN warehouses w ON w.id = b.warehouse_id
       WHERE b.company_id = $1 AND b.expires_on BETWEEN CURRENT_DATE AND CURRENT_DATE + $2::int
         AND b.quantity > 0 ORDER BY b.expires_on LIMIT 500`,
      [companyId, days],
    ),
  ]);
  response.json({ lowStock: lowStock.rows, expiring: expiring.rows });
});

router.get("/inventory/balances", authenticate, async (request, response) => {
  const warehouseId = typeof request.query.warehouseId === "string" ? parse(uuidSchema, request.query.warehouseId) : null;
  const result = await query(
    `SELECT b.warehouse_id AS "warehouseId", w.name AS "warehouseName", b.product_id AS "productId",
            b.product_name AS "productName", b.inventory_product_id AS "inventoryProductId",
            b.unit, b.batch_number AS "batchNumber",
            b.expires_on AS "expiresOn", b.quantity
     FROM inventory_balances b JOIN warehouses w ON w.id = b.warehouse_id AND w.company_id = b.company_id
     WHERE b.company_id = $1 AND ($2::uuid IS NULL OR b.warehouse_id = $2)
     ORDER BY w.name, b.product_name, b.expires_on NULLS LAST LIMIT 1000`,
    [request.context!.companyId, warehouseId],
  );
  response.json({ data: result.rows });
});

router.get("/inventory/movements", authenticate, async (request, response) => {
  const result = await query(
    `SELECT m.id, m.warehouse_id AS "warehouseId", w.name AS "warehouseName",
            m.product_id AS "productId", m.product_name AS "productName", m.movement_type AS "movementType",
            m.quantity, m.is_increase AS "isIncrease", m.unit, m.batch_number AS "batchNumber",
            m.expires_on AS "expiresOn", m.reference, m.notes, m.created_at AS "createdAt",
            u.full_name AS "createdBy"
     FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id
     JOIN users u ON u.id = m.actor_user_id
     WHERE m.company_id = $1 ORDER BY m.created_at DESC LIMIT 300`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.get("/inventory/counts", authenticate, requireCompany("customer"), async (request, response) => {
  const result = await query(
    `SELECT c.id, c.warehouse_id AS "warehouseId", w.name AS "warehouseName", c.status,
            c.created_at AS "createdAt", c.completed_at AS "completedAt",
            count(i.id)::int AS "itemCount",
            count(i.id) FILTER (WHERE i.difference <> 0)::int AS "discrepancyCount"
     FROM inventory_counts c JOIN warehouses w ON w.id = c.warehouse_id
     LEFT JOIN inventory_count_items i ON i.count_id = c.id
     WHERE c.company_id = $1 GROUP BY c.id, w.name ORDER BY c.created_at DESC LIMIT 100`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.post("/inventory/movements", authenticate, requireCompany("customer"), requireRole(...managerRoles, "warehouse"), async (request, response) => {
  const input = parse(z.object({
    warehouseId: uuidSchema,
    productId: uuidSchema.optional(),
    inventoryProductId: uuidSchema.optional(),
    productName: textSchema(1, 200),
    movementType: z.enum(stockTypes),
    quantity: quantitySchema,
    isIncrease: z.boolean().optional(),
    unit: textSchema(1, 40),
    batchNumber: z.string().trim().max(100).optional(),
    expiresOn: z.iso.date().optional(),
    reference: z.string().trim().max(120).optional(),
    notes: z.string().trim().max(1000).optional(),
  }).strict(), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  if (input.movementType === "adjustment" && input.isIncrease === undefined) {
    throw new ApiError(400, "حدد ما إذا كان الجرد يزيد الكمية أو يخفضها.", "ADJUSTMENT_DIRECTION_REQUIRED");
  }
  const isIncrease = input.movementType === "receipt" || (input.movementType === "adjustment" && input.isIncrease === true);
  const created = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.warehouseId]);
    const warehouse = await client.query<{ id: string }>(
      "SELECT id FROM warehouses WHERE id = $1 AND company_id = $2",
      [input.warehouseId, context.companyId],
    );
    invariant(warehouse.rowCount === 1, 404, "المستودع غير موجود في شركتك.", "WAREHOUSE_NOT_FOUND");
    if (input.productId) {
      const product = await client.query<{ name: string; unit: string }>("SELECT name, unit FROM products WHERE id = $1 AND is_active = true", [input.productId]);
      invariant(product.rowCount === 1, 404, "المنتج غير موجود أو غير فعال.", "PRODUCT_NOT_FOUND");
      invariant(product.rows[0]!.name === input.productName && product.rows[0]!.unit === input.unit,
        400, "اسم ووحدة المنتج يجب أن يطابقا الكتالوج.", "PRODUCT_DETAILS_MISMATCH");
    }
    if (input.inventoryProductId) {
      const product = await client.query<{ name: string; unit: string }>(
        "SELECT name, unit FROM inventory_products WHERE id = $1 AND company_id = $2 AND is_active = true",
        [input.inventoryProductId, context.companyId],
      );
      invariant(product.rows[0], 404, "المنتج غير موجود في مخزون شركتك.", "INVENTORY_PRODUCT_NOT_FOUND");
      invariant(product.rows[0].name === input.productName && product.rows[0].unit === input.unit,
        400, "اسم ووحدة المنتج يجب أن يطابقا سجل المخزون.", "PRODUCT_DETAILS_MISMATCH");
    }
    if (!isIncrease) {
      const balance = await client.query<{ available: string }>(
        `SELECT COALESCE(SUM(CASE WHEN movement_type IN ('receipt', 'transfer_in') OR (movement_type = 'adjustment' AND is_increase)
                                   THEN quantity ELSE -quantity END), 0)::text AS available
         FROM stock_movements
         WHERE company_id = $1 AND warehouse_id = $2 AND product_name = $3 AND unit = $4
           AND batch_number IS NOT DISTINCT FROM $5 AND expires_on IS NOT DISTINCT FROM $6`,
        [context.companyId, input.warehouseId, input.productName, input.unit, input.batchNumber ?? null, input.expiresOn ?? null],
      );
      const available = Number(balance.rows[0]?.available ?? 0);
      invariant(available >= input.quantity, 409, `الكمية المتاحة (${available}) أقل من الكمية المطلوبة.`, "INSUFFICIENT_STOCK");
    }
    const movement = await client.query(
      `INSERT INTO stock_movements
       (company_id, warehouse_id, product_id, inventory_product_id, product_name, movement_type, quantity, is_increase, unit, batch_number, expires_on, reference, notes, actor_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id, product_name AS "productName", movement_type AS "movementType", quantity, unit, created_at AS "createdAt"`,
      [context.companyId, input.warehouseId, input.productId ?? null, input.inventoryProductId ?? null, input.productName, input.movementType, input.quantity, isIncrease, input.unit,
        input.batchNumber ?? null, input.expiresOn ?? null, input.reference ?? null, input.notes ?? null, context.userId],
    );
    await audit(client, context.companyId, context.userId, `inventory.${input.movementType}`, "stock_movement", movement.rows[0].id);
    if (input.inventoryProductId) {
      await evaluateManagedInventory(client, context.companyId, input.warehouseId, context.userId, input.inventoryProductId);
    }
    return movement.rows[0];
  });
  response.status(201).json(created);
});

router.post("/inventory/transfers", authenticate, requireCompany("customer"), requireRole(...managerRoles, "warehouse"), async (request, response) => {
  const input = parse(z.object({
    sourceWarehouseId: uuidSchema,
    destinationWarehouseId: uuidSchema,
    inventoryProductId: uuidSchema,
    quantity: quantitySchema,
    batchNumber: z.string().trim().max(100).optional(),
    expiresOn: z.iso.date().optional(),
    reference: z.string().trim().max(120).optional(),
    notes: z.string().trim().max(1000).optional(),
  }).strict(), request.body);
  invariant(input.sourceWarehouseId !== input.destinationWarehouseId, 400, "اختر مستودعين مختلفين.", "INVALID_TRANSFER");
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const result = await transaction(async (client) => {
    for (const warehouseId of [input.sourceWarehouseId, input.destinationWarehouseId].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [warehouseId]);
    }
    const warehouses = await client.query<{ id: string }>(
      "SELECT id FROM warehouses WHERE company_id = $1 AND id = ANY($2::uuid[])",
      [context.companyId, [input.sourceWarehouseId, input.destinationWarehouseId]],
    );
    invariant(warehouses.rowCount === 2, 404, "يجب أن يكون المستودعان تابعين لشركتك.", "WAREHOUSE_NOT_FOUND");
    const product = await client.query<{ id: string; source_product_id: string | null; name: string; unit: string }>(
      "SELECT id, source_product_id, name, unit FROM inventory_products WHERE id = $1 AND company_id = $2 AND is_active = true",
      [input.inventoryProductId, context.companyId],
    );
    invariant(product.rows[0], 404, "الصنف غير موجود في مخزون شركتك.", "INVENTORY_PRODUCT_NOT_FOUND");
    const balance = await client.query<{ available: string }>(
      `SELECT COALESCE(SUM(CASE WHEN movement_type IN ('receipt', 'transfer_in') OR (movement_type = 'adjustment' AND is_increase)
                               THEN quantity ELSE -quantity END), 0)::text AS available
       FROM stock_movements
       WHERE company_id = $1 AND warehouse_id = $2 AND inventory_product_id = $3
         AND batch_number IS NOT DISTINCT FROM $4 AND expires_on IS NOT DISTINCT FROM $5`,
      [context.companyId, input.sourceWarehouseId, input.inventoryProductId, input.batchNumber ?? null, input.expiresOn ?? null],
    );
    invariant(Number(balance.rows[0]!.available) >= input.quantity, 409, "الكمية المتاحة لا تكفي للتحويل.", "INSUFFICIENT_STOCK");
    const reference = input.reference || `TR-${randomUUID()}`;
    for (const [warehouseId, movementType] of [
      [input.sourceWarehouseId, "transfer_out"],
      [input.destinationWarehouseId, "transfer_in"],
    ] as const) {
      await client.query(
        `INSERT INTO stock_movements
         (company_id, warehouse_id, product_id, inventory_product_id, product_name, movement_type, quantity, unit, batch_number, expires_on, reference, notes, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [context.companyId, warehouseId, product.rows[0].source_product_id, product.rows[0].id, product.rows[0].name, movementType,
          input.quantity, product.rows[0].unit, input.batchNumber ?? null, input.expiresOn ?? null, reference, input.notes ?? null, context.userId],
      );
    }
    await evaluateManagedInventory(client, context.companyId, input.sourceWarehouseId, context.userId, input.inventoryProductId);
    await evaluateManagedInventory(client, context.companyId, input.destinationWarehouseId, context.userId, input.inventoryProductId);
    await audit(client, context.companyId, context.userId, "inventory.transfer", "inventory_product", input.inventoryProductId, {
      sourceWarehouseId: input.sourceWarehouseId,
      destinationWarehouseId: input.destinationWarehouseId,
      quantity: input.quantity,
      reference,
    });
    return { reference, productName: product.rows[0].name, quantity: input.quantity, unit: product.rows[0].unit };
  });
  response.status(201).json(result);
});

router.post("/inventory/counts", authenticate, requireCompany("customer"), requireRole(...managerRoles, "warehouse"), async (request, response) => {
  const input = parse(z.object({ warehouseId: uuidSchema }), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const created = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.warehouseId]);
    const warehouse = await client.query("SELECT 1 FROM warehouses WHERE id = $1 AND company_id = $2", [input.warehouseId, context.companyId]);
    invariant(warehouse.rowCount === 1, 404, "المستودع غير موجود في شركتك.", "WAREHOUSE_NOT_FOUND");
    const count = await client.query<{ id: string }>(
      "INSERT INTO inventory_counts (company_id, warehouse_id, created_by) VALUES ($1, $2, $3) RETURNING id",
      [context.companyId, input.warehouseId, context.userId],
    );
    const countId = count.rows[0]!.id;
    await client.query(
      `INSERT INTO inventory_count_items
       (count_id, product_id, inventory_product_id, product_name, unit, batch_number, expires_on, expected_quantity, counted_quantity, difference)
       SELECT $1::uuid, b.product_id, b.inventory_product_id, b.product_name, b.unit, b.batch_number, b.expires_on, b.quantity, b.quantity, 0
       FROM inventory_balances b
       WHERE b.company_id = $2 AND b.warehouse_id = $3 AND b.quantity > 0
       UNION ALL
       SELECT $1::uuid, p.source_product_id, p.id, p.name, p.unit, NULL, NULL, 0, 0, 0
       FROM inventory_products p
       WHERE p.company_id = $2 AND p.is_active = true
         AND NOT EXISTS (
           SELECT 1 FROM inventory_balances b
           WHERE b.company_id = p.company_id AND b.warehouse_id = $3 AND b.inventory_product_id = p.id
         )`,
      [countId, context.companyId, input.warehouseId],
    );
    return countId;
  });
  response.status(201).json({ id: created, status: "open" });
});

router.get("/inventory/counts/:id", authenticate, async (request, response) => {
  const countId = parse(uuidSchema, request.params.id);
  const count = await query(
    `SELECT id, warehouse_id AS "warehouseId", status, created_at AS "createdAt", completed_at AS "completedAt"
     FROM inventory_counts WHERE id = $1 AND company_id = $2`,
    [countId, request.context!.companyId],
  );
  invariant(count.rows[0], 404, "جلسة الجرد غير موجودة.", "INVENTORY_COUNT_NOT_FOUND");
  const items = await query(
    `SELECT id, product_name AS "productName", unit, batch_number AS "batchNumber",
            expected_quantity AS "expectedQuantity", counted_quantity AS "countedQuantity", difference
     FROM inventory_count_items WHERE count_id = $1 ORDER BY product_name`,
    [countId],
  );
  response.json({ ...count.rows[0], items: items.rows });
});

router.put("/inventory/counts/:id/items/:itemId", authenticate, requireCompany("customer"), requireRole(...managerRoles, "warehouse"), async (request, response) => {
  const countId = parse(uuidSchema, request.params.id);
  const itemId = parse(uuidSchema, request.params.itemId);
  const input = parse(z.object({ countedQuantity: z.coerce.number().finite().nonnegative().max(1_000_000_000) }), request.body);
  const result = await query(
    `UPDATE inventory_count_items i SET counted_quantity = $1, difference = $1 - expected_quantity
     FROM inventory_counts c
     WHERE i.id = $2 AND i.count_id = c.id AND c.id = $3 AND c.company_id = $4 AND c.status = 'open'
     RETURNING i.id, i.expected_quantity AS "expectedQuantity", i.counted_quantity AS "countedQuantity", i.difference`,
    [input.countedQuantity, itemId, countId, request.context!.companyId],
  );
  invariant(result.rows[0], 404, "سطر الجرد غير موجود أو أن الجرد مغلق.", "COUNT_ITEM_NOT_FOUND");
  response.json(result.rows[0]);
});

router.post("/inventory/counts/:id/items", authenticate, requireCompany("customer"), requireRole(...managerRoles, "warehouse"), async (request, response) => {
  const countId = parse(uuidSchema, request.params.id);
  const input = parse(z.object({
    inventoryProductId: uuidSchema,
    batchNumber: z.string().trim().max(100).optional(),
    expiresOn: z.iso.date().optional(),
    countedQuantity: z.coerce.number().finite().nonnegative().max(1_000_000_000),
  }).strict(), request.body);
  const context = request.context!;
  const result = await transaction(async (client) => {
    const count = await client.query<{ warehouse_id: string }>(
      "SELECT warehouse_id FROM inventory_counts WHERE id = $1 AND company_id = $2 AND status = 'open' FOR UPDATE",
      [countId, context.companyId],
    );
    invariant(count.rows[0], 404, "جلسة الجرد غير موجودة أو مغلقة.", "INVENTORY_COUNT_NOT_OPEN");
    const product = await client.query<{ id: string; source_product_id: string | null; name: string; unit: string }>(
      "SELECT id, source_product_id, name, unit FROM inventory_products WHERE id = $1 AND company_id = $2 AND is_active = true",
      [input.inventoryProductId, context.companyId],
    );
    invariant(product.rows[0], 404, "المنتج غير موجود في مخزون شركتك.", "INVENTORY_PRODUCT_NOT_FOUND");
    const existing = await client.query(
      `SELECT 1 FROM inventory_count_items
       WHERE count_id = $1 AND inventory_product_id = $2
         AND batch_number IS NOT DISTINCT FROM $3 AND expires_on IS NOT DISTINCT FROM $4`,
      [countId, input.inventoryProductId, input.batchNumber ?? null, input.expiresOn ?? null],
    );
    invariant(existing.rowCount === 0, 409, "هذا المنتج والدفعة موجودان بالفعل في الجرد.", "DUPLICATE_COUNT_ITEM");
    const expected = await client.query<{ quantity: string }>(
      `SELECT COALESCE(SUM(CASE WHEN movement_type IN ('receipt', 'transfer_in') OR (movement_type = 'adjustment' AND is_increase)
                               THEN quantity ELSE -quantity END), 0)::text AS quantity
       FROM stock_movements
       WHERE company_id = $1 AND warehouse_id = $2 AND inventory_product_id = $3
         AND batch_number IS NOT DISTINCT FROM $4 AND expires_on IS NOT DISTINCT FROM $5`,
      [context.companyId, count.rows[0].warehouse_id, input.inventoryProductId, input.batchNumber ?? null, input.expiresOn ?? null],
    );
    const expectedQuantity = Number(expected.rows[0]!.quantity);
    const item = await client.query(
      `INSERT INTO inventory_count_items
       (count_id, product_id, inventory_product_id, product_name, unit, batch_number, expires_on, expected_quantity, counted_quantity, difference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9 - $8)
       RETURNING id, product_name AS "productName", unit, batch_number AS "batchNumber",
                 expires_on AS "expiresOn", expected_quantity AS "expectedQuantity",
                 counted_quantity AS "countedQuantity", difference`,
      [countId, product.rows[0].source_product_id, product.rows[0].id, product.rows[0].name, product.rows[0].unit,
        input.batchNumber ?? null, input.expiresOn ?? null, expectedQuantity, input.countedQuantity],
    );
    return item.rows[0];
  });
  response.status(201).json(result);
});

router.post("/inventory/counts/:id/complete", authenticate, requireCompany("customer"), requireRole(...managerRoles, "warehouse"), async (request, response) => {
  const countId = parse(uuidSchema, request.params.id);
  const context = request.context!;
  const result = await transaction(async (client) => {
    const count = await client.query<{ warehouse_id: string; status: string }>(
      "SELECT warehouse_id, status FROM inventory_counts WHERE id = $1 AND company_id = $2 FOR UPDATE",
      [countId, context.companyId],
    );
    const record = count.rows[0];
    invariant(record?.status === "open", 404, "جلسة الجرد غير موجودة أو مغلقة.", "INVENTORY_COUNT_NOT_OPEN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [record.warehouse_id]);
    const items = await client.query<{
      product_id: string | null; product_name: string; unit: string; batch_number: string | null;
      inventory_product_id: string | null; expires_on: Date | null;
      expected_quantity: string; counted_quantity: string; difference: string;
    }>(
      "SELECT product_id, inventory_product_id, product_name, unit, batch_number, expires_on, expected_quantity, counted_quantity, difference FROM inventory_count_items WHERE count_id = $1 AND difference <> 0",
      [countId],
    );
    for (const item of items.rows) {
      const difference = Number(item.difference);
      await client.query(
        `INSERT INTO stock_movements
         (company_id, warehouse_id, product_id, inventory_product_id, product_name, movement_type, quantity, is_increase, unit, batch_number, expires_on, reference, notes, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, 'adjustment', $6, $7, $8, $9, $10, $11, $12, $13)`,
        [context.companyId, record.warehouse_id, item.product_id, item.inventory_product_id, item.product_name, Math.abs(difference), difference > 0, item.unit,
          item.batch_number, item.expires_on, `COUNT-${countId}`, "تسوية نتيجة الجرد الدوري", context.userId],
      );
    }
    await evaluateManagedInventory(client, context.companyId, record.warehouse_id, context.userId);
    await client.query("UPDATE inventory_counts SET status = 'completed', completed_at = now() WHERE id = $1", [countId]);
    await audit(client, context.companyId, context.userId, "inventory.count.completed", "inventory_count", countId, { adjustments: items.rowCount });
    const total = await client.query<{ items: number; accurate: number }>(
      `SELECT count(*)::int AS items, count(*) FILTER (WHERE difference = 0)::int AS accurate
       FROM inventory_count_items WHERE count_id = $1`,
      [countId],
    );
    const counts = total.rows[0]!;
    return { id: countId, status: "completed", adjustedItems: items.rowCount, inventoryAccuracy: counts.items ? counts.accurate / counts.items : 1 };
  });
  response.json(result);
});

router.get("/shipments", authenticate, async (request, response) => {
  const context = request.context!;
  if (context.companyType !== "customer" && context.companyType !== "logistics_provider" && context.companyType !== "operator") {
    throw new ApiError(403, "لا تتاح الشحنات لهذه المنصة.", "COMPANY_TYPE_FORBIDDEN");
  }
  const column = context.companyType === "logistics_provider" ? "carrier_company_id" : "customer_company_id";
  const result = await query(
    `SELECT s.id, s.reference, s.order_id AS "orderId", s.status,
            s.temperature_requirement AS "temperatureRequirement", s.pickup_address AS "pickupAddress",
            s.delivery_address AS "deliveryAddress", s.scheduled_at AS "scheduledAt", s.delivered_at AS "deliveredAt",
            s.proof_of_delivery_url AS "proofOfDeliveryUrl", s.carrier_company_id AS "carrierCompanyId",
            s.carrier_vehicle_id AS "carrierVehicleId", s.driver_user_id AS "driverUserId",
            s.pickup_city AS "pickupCity", s.delivery_city AS "deliveryCity",
            s.estimated_weight_kg AS "estimatedWeightKg",
            carrier.display_name AS "carrierName", customer.display_name AS "customerName",
            s.created_at AS "createdAt"
     FROM shipments s
     JOIN companies customer ON customer.id = s.customer_company_id
     LEFT JOIN companies carrier ON carrier.id = s.carrier_company_id
     WHERE s.${column} = $1 ORDER BY s.created_at DESC LIMIT 200`,
    [context.companyId],
  );
  response.json({ data: result.rows });
});

router.post("/shipments", authenticate, requireCompany("customer"), requireRole(...managerRoles, "purchaser"), async (request, response) => {
  const input = parse(z.object({
    orderId: uuidSchema.optional(),
    temperatureRequirement: temperatureSchema.optional(),
    estimatedWeightKg: z.coerce.number().finite().positive().max(1_000_000).optional(),
    pickupAddress: textSchema(5, 500),
    deliveryAddress: textSchema(5, 500),
    pickupCity: textSchema(2, 100),
    deliveryCity: textSchema(2, 100),
    scheduledAt: z.iso.datetime().optional(),
  }).strict(), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const result = await transaction(async (client) => {
    if (input.orderId) {
      const order = await client.query(
        "SELECT 1 FROM orders WHERE id = $1 AND customer_company_id = $2 AND status <> 'cancelled'",
        [input.orderId, context.companyId],
      );
      invariant(order.rowCount === 1, 404, "أمر الشراء غير موجود في شركتك.", "ORDER_NOT_FOUND");
    }
    const shipment = await client.query(
      `INSERT INTO shipments (reference, order_id, customer_company_id, estimated_weight_kg,
                              status, temperature_requirement, pickup_address, delivery_address, pickup_city, delivery_city, scheduled_at)
       VALUES ('SHP-' || to_char(now(), 'YYYY') || '-' || upper(replace(gen_random_uuid()::text, '-', '')),
               $1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9)
       RETURNING id, reference, status, pickup_address AS "pickupAddress", delivery_address AS "deliveryAddress", created_at AS "createdAt"`,
      [input.orderId ?? null, context.companyId, input.estimatedWeightKg ?? null,
        input.temperatureRequirement ?? "ambient", input.pickupAddress, input.deliveryAddress,
        input.pickupCity, input.deliveryCity, input.scheduledAt ?? null],
    );
    await client.query("INSERT INTO shipment_events (shipment_id, status, actor_user_id) VALUES ($1, 'pending', $2)", [shipment.rows[0].id, context.userId]);
    await audit(client, context.companyId, context.userId, "shipment.created", "shipment", shipment.rows[0].id);
    return shipment.rows[0];
  });
  response.status(201).json(result);
});

router.patch("/shipments/:id/assign", authenticate, requireCompany("customer"), requireRole(...managerRoles, "purchaser"), async (request, response) => {
  const shipmentId = parse(uuidSchema, request.params.id);
  const input = parse(z.object({
    carrierCompanyId: uuidSchema,
    vehicleId: uuidSchema.optional(),
    driverUserId: uuidSchema.optional(),
  }).strict(), request.body);
  const context = request.context!;
  const result = await transaction(async (client) => {
    const shipment = await client.query<{
      pickup_city: string; delivery_city: string; temperature_requirement: string; estimated_weight_kg: string | null;
    }>(
      `SELECT pickup_city, delivery_city, temperature_requirement, estimated_weight_kg
       FROM shipments WHERE id = $1 AND customer_company_id = $2 AND status = 'pending' FOR UPDATE`,
      [shipmentId, context.companyId],
    );
    invariant(shipment.rows[0], 409, "لا يمكن إسناد الشحنة في حالتها الحالية.", "SHIPMENT_NOT_ASSIGNABLE");
    const carrier = await client.query(
      `SELECT 1 FROM carrier_profiles p JOIN companies c ON c.id = p.company_id
       WHERE p.company_id = $1 AND c.type = 'logistics_provider' AND c.status = 'active'
         AND $2 = ANY(p.coverage_cities) AND $3 = ANY(p.coverage_cities)
         AND $4 = ANY(p.temperature_capabilities)
         AND (p.max_payload_kg IS NULL OR $5::numeric IS NULL OR p.max_payload_kg >= $5)`,
      [input.carrierCompanyId, shipment.rows[0].pickup_city, shipment.rows[0].delivery_city,
        shipment.rows[0].temperature_requirement, shipment.rows[0].estimated_weight_kg],
    );
    invariant(carrier.rowCount === 1, 400, "شركة النقل غير متاحة لمتطلبات الشحنة.", "CARRIER_NOT_AVAILABLE");
    if (input.vehicleId) {
      const vehicle = await client.query(
        `SELECT 1 FROM carrier_vehicles WHERE id = $1 AND company_id = $2 AND is_active
           AND $3 = ANY(temperature_capabilities)
           AND ($4::numeric IS NULL OR max_payload_kg >= $4)`,
        [input.vehicleId, input.carrierCompanyId, shipment.rows[0].temperature_requirement, shipment.rows[0].estimated_weight_kg],
      );
      invariant(vehicle.rowCount === 1, 400, "المركبة غير متاحة أو لا تلائم الشحنة.", "VEHICLE_NOT_AVAILABLE");
    }
    if (input.driverUserId) {
      const driver = await client.query(
        `SELECT 1 FROM company_memberships m JOIN users u ON u.id = m.user_id
         WHERE m.company_id = $1 AND m.user_id = $2 AND m.role = 'driver' AND u.is_active`,
        [input.carrierCompanyId, input.driverUserId],
      );
      invariant(driver.rowCount === 1, 400, "السائق غير نشط أو غير تابع لشركة النقل.", "DRIVER_NOT_AVAILABLE");
    }
    const updated = await client.query(
      `UPDATE shipments SET carrier_company_id = $1, carrier_vehicle_id = $2, driver_user_id = $3, status = 'assigned'
       WHERE id = $4 AND customer_company_id = $5 AND status = 'pending'
       RETURNING id, reference, status, carrier_company_id AS "carrierCompanyId"`,
      [input.carrierCompanyId, input.vehicleId ?? null, input.driverUserId ?? null, shipmentId, context.companyId],
    );
    invariant(updated.rows[0], 409, "لا يمكن إسناد الشحنة في حالتها الحالية.", "SHIPMENT_NOT_ASSIGNABLE");
    await client.query(
      "INSERT INTO shipment_events (shipment_id, status, actor_user_id) VALUES ($1, 'assigned', $2)",
      [shipmentId, context.userId],
    );
    await audit(client, context.companyId, context.userId, "shipment.assigned", "shipment", shipmentId, { carrierCompanyId: input.carrierCompanyId });
    return updated.rows[0];
  });
  response.json(result);
});

router.patch("/shipments/:id/dispatch", authenticate, requireCompany("logistics_provider"), requireRole(...managerRoles), async (request, response) => {
  const shipmentId = parse(uuidSchema, request.params.id);
  const input = parse(z.object({
    vehicleId: uuidSchema,
    driverUserId: uuidSchema.optional(),
  }).strict(), request.body);
  const context = request.context!;
  const result = await transaction(async (client) => {
    const shipment = await client.query<{ status: string; temperature_requirement: string; estimated_weight_kg: string | null }>(
      "SELECT status, temperature_requirement, estimated_weight_kg FROM shipments WHERE id = $1 AND carrier_company_id = $2 FOR UPDATE",
      [shipmentId, context.companyId],
    );
    invariant(shipment.rows[0]?.status === "assigned", 404, "الشحنة غير مسندة لشركتك أو غير قابلة للتجهيز.", "SHIPMENT_NOT_ASSIGNABLE");
    const vehicle = await client.query(
      `SELECT 1 FROM carrier_vehicles WHERE id = $1 AND company_id = $2 AND is_active
         AND $3 = ANY(temperature_capabilities)
         AND ($4::numeric IS NULL OR max_payload_kg >= $4)`,
      [input.vehicleId, context.companyId, shipment.rows[0].temperature_requirement, shipment.rows[0].estimated_weight_kg],
    );
    invariant(vehicle.rowCount === 1, 400, "المركبة لا تلائم درجة الحرارة أو الوزن المطلوب.", "VEHICLE_NOT_AVAILABLE");
    if (input.driverUserId) {
      const driver = await client.query(
        `SELECT 1 FROM company_memberships m JOIN users u ON u.id = m.user_id
         WHERE m.company_id = $1 AND m.user_id = $2 AND m.role = 'driver' AND u.is_active`,
        [context.companyId, input.driverUserId],
      );
      invariant(driver.rowCount === 1, 400, "السائق غير نشط أو غير تابع لشركة النقل.", "DRIVER_NOT_AVAILABLE");
    }
    const updated = await client.query(
      `UPDATE shipments SET carrier_vehicle_id = $1, driver_user_id = $2
       WHERE id = $3 RETURNING id, reference, status, carrier_vehicle_id AS "vehicleId", driver_user_id AS "driverUserId"`,
      [input.vehicleId, input.driverUserId ?? null, shipmentId],
    );
    await audit(client, context.companyId, context.userId, "shipment.dispatched", "shipment", shipmentId, { vehicleId: input.vehicleId });
    return updated.rows[0];
  });
  response.json(result);
});

router.patch("/shipments/:id/status", authenticate, async (request, response) => {
  const shipmentId = parse(uuidSchema, request.params.id);
  const input = parse(z.object({
    status: z.enum(["picked_up", "in_transit", "delivered", "exception", "cancelled"]),
    location: z.string().trim().max(200).optional(),
    notes: z.string().trim().max(1000).optional(),
    proofOfDeliveryUrl: z.url().refine((value) => value.startsWith("https://")).optional(),
  }).strict(), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const updated = await transaction(async (client) => {
    const current = await client.query<{
      status: string; customer_company_id: string; carrier_company_id: string | null;
    }>("SELECT status, customer_company_id, carrier_company_id FROM shipments WHERE id = $1 FOR UPDATE", [shipmentId]);
    const shipment = current.rows[0];
    invariant(shipment, 404, "الشحنة غير موجودة.", "SHIPMENT_NOT_FOUND");
    const isCustomer = shipment.customer_company_id === context.companyId;
    const isCarrier = shipment.carrier_company_id === context.companyId;
    if (isCarrier) {
      invariant(["owner", "admin", "manager", "driver"].includes(context.role), 403, "لا تملك صلاحية تشغيل الشحنة.", "ROLE_FORBIDDEN");
    }
    if (isCarrier && context.role === "driver") {
      const assigned = await client.query(
        "SELECT 1 FROM shipments WHERE id = $1 AND driver_user_id = $2",
        [shipmentId, context.userId],
      );
      invariant(assigned.rowCount === 1, 403, "هذه الشحنة غير مسندة إليك.", "DRIVER_ASSIGNMENT_REQUIRED");
    }
    if (isCustomer) {
      invariant(["owner", "admin", "manager", "purchaser"].includes(context.role), 403, "لا تملك صلاحية على الشحنة.", "ROLE_FORBIDDEN");
    }
    const customerMayCancel = isCustomer && input.status === "cancelled" && ["pending", "assigned"].includes(shipment.status);
    const carrierTransitions: Record<string, string[]> = {
      assigned: ["picked_up", "exception"],
      picked_up: ["in_transit", "exception"],
      in_transit: ["delivered", "exception"],
      exception: ["in_transit", "cancelled"],
    };
    const carrierMayChange = isCarrier && (carrierTransitions[shipment.status]?.includes(input.status) ?? false);
    invariant(customerMayCancel || carrierMayChange, 409, "تغيير حالة الشحنة غير مسموح في مرحلتها الحالية.", "INVALID_STATUS_TRANSITION");
    if (input.status === "delivered") {
      invariant(input.proofOfDeliveryUrl, 400, "أرفق رابط إثبات التسليم قبل إغلاق الشحنة.", "PROOF_OF_DELIVERY_REQUIRED");
    }
    const result = await client.query(
      `UPDATE shipments SET status = $1,
         delivered_at = CASE WHEN $1::shipment_status = 'delivered'::shipment_status THEN now() ELSE delivered_at END,
         proof_of_delivery_url = COALESCE($2, proof_of_delivery_url)
       WHERE id = $3
       RETURNING id, reference, status, delivered_at AS "deliveredAt"`,
      [input.status, input.proofOfDeliveryUrl ?? null, shipmentId],
    );
    await client.query(
      `INSERT INTO shipment_events (shipment_id, status, location, notes, actor_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [shipmentId, input.status, input.location ?? null, input.notes ?? null, context.userId],
    );
    await audit(client, context.companyId, context.userId, `shipment.${input.status}`, "shipment", shipmentId);
    return result.rows[0];
  });
  response.json(updated);
});

router.get("/shipments/:id/events", authenticate, async (request, response) => {
  const shipmentId = parse(uuidSchema, request.params.id);
  const access = await query(
    "SELECT 1 FROM shipments WHERE id = $1 AND (customer_company_id = $2 OR carrier_company_id = $2)",
    [shipmentId, request.context!.companyId],
  );
  invariant(access.rowCount === 1, 404, "الشحنة غير موجودة.", "SHIPMENT_NOT_FOUND");
  const events = await query(
    `SELECT e.id, e.status, e.location, e.notes, e.created_at AS "createdAt", u.full_name AS "createdBy"
     FROM shipment_events e JOIN users u ON u.id = e.actor_user_id
     WHERE e.shipment_id = $1 ORDER BY e.created_at`,
    [shipmentId],
  );
  response.json({ data: events.rows });
});

export default router;

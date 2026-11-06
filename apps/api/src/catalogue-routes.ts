import { Router } from "express";
import { z } from "zod";
import { authenticate, requireCompany, requireRole } from "./auth.js";
import { audit, ensureCompanyActive, query, transaction } from "./db.js";
import { invariant } from "./errors.js";
import {
  parse, productPriceTiersSchema, productSpecificationsSchema, quantitySchema, textSchema, uuidSchema,
} from "./validation.js";

const router = Router();
function productPriceTiers(tiers: Array<{ minimumQuantity: number; unitPrice: number }>) {
  return [...tiers].sort((left, right) => left.minimumQuantity - right.minimumQuantity);
}

router.get("/public/products", async (request, response) => {
  const search = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 100) : "";
  const region = typeof request.query.region === "string" ? request.query.region.trim().slice(0, 100) : "";
  const pricingMode = request.query.pricing === undefined
    ? null
    : parse(z.enum(["public", "quote"]), request.query.pricing);
  const result = await query(
    `SELECT p.id, p.sku, p.name, p.description, p.unit, p.image_url AS "imageUrl",
            p.minimum_order_quantity AS "minimumOrderQuantity", c.id AS "supplierCompanyId",
            c.display_name AS "supplierName", p.pricing_mode AS "pricingMode",
            COALESCE(c.metadata->>'demo' = 'true', false) AS "isDemo",
            CASE WHEN p.pricing_mode = 'public' THEN p.unit_price END AS "unitPrice",
            p.currency, p.production_capacity AS "productionCapacity", p.lead_time_days AS "leadTimeDays",
            p.delivery_regions AS "deliveryRegions", p.specifications,
            CASE WHEN p.pricing_mode = 'public' THEN COALESCE((
              SELECT jsonb_agg(jsonb_build_object('minimumQuantity', t.minimum_quantity, 'unitPrice', t.unit_price)
                ORDER BY t.minimum_quantity) FROM product_price_tiers t WHERE t.product_id = p.id
            ), '[]'::jsonb) ELSE '[]'::jsonb END AS "priceTiers"
     FROM products p JOIN companies c ON c.id = p.supplier_company_id
     WHERE p.is_active = true AND c.status = 'active' AND c.type = 'supplier'
       AND ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR p.sku ILIKE '%' || $1 || '%'
            OR c.display_name ILIKE '%' || $1 || '%' OR p.description ILIKE '%' || $1 || '%'
            OR p.specifications::text ILIKE '%' || $1 || '%')
       AND ($2 = '' OR $2 = ANY(p.delivery_regions))
       AND ($3::text IS NULL OR p.pricing_mode = $3)
     ORDER BY p.created_at DESC LIMIT 200`,
    [search, region, pricingMode],
  );
  response.json({ data: result.rows });
});

router.get("/public/services", async (request, response) => {
  const search = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 100) : "";
  const result = await query(
    `SELECT s.id, s.name, s.category, s.description, s.coverage, s.price_from AS "priceFrom",
            s.currency, c.id AS "providerCompanyId", c.display_name AS "providerName"
     FROM service_listings s JOIN companies c ON c.id = s.provider_company_id
     WHERE s.is_active = true AND c.status = 'active' AND c.type = 'service_provider'
       AND ($1 = '' OR s.name ILIKE '%' || $1 || '%' OR s.category ILIKE '%' || $1 || '%'
            OR s.description ILIKE '%' || $1 || '%' OR c.display_name ILIKE '%' || $1 || '%'
            OR s.coverage::text ILIKE '%' || $1 || '%')
     ORDER BY s.created_at DESC LIMIT 200`,
    [search],
  );
  response.json({ data: result.rows });
});

router.get("/directory/companies", authenticate, async (request, response) => {
  const type = parse(z.enum(["supplier", "service_provider", "logistics_provider"]), request.query.type);
  const result = await query(
    `SELECT id, display_name AS "displayName", type
     FROM companies WHERE type = $1 AND status = 'active' ORDER BY display_name LIMIT 200`,
    [type],
  );
  response.json({ data: result.rows });
});

router.get("/products/mine", authenticate, requireCompany("supplier"), async (request, response) => {
  const result = await query(
    `SELECT p.id, p.sku, p.name, p.description, p.unit, p.minimum_order_quantity AS "minimumOrderQuantity",
            p.pricing_mode AS "pricingMode", p.unit_price AS "unitPrice", p.currency,
            p.production_capacity AS "productionCapacity", p.lead_time_days AS "leadTimeDays",
            p.delivery_regions AS "deliveryRegions", p.specifications,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('minimumQuantity', t.minimum_quantity, 'unitPrice', t.unit_price)
              ORDER BY t.minimum_quantity) FROM product_price_tiers t WHERE t.product_id = p.id), '[]'::jsonb) AS "priceTiers",
            p.is_active AS "isActive", p.created_at AS "createdAt"
     FROM products p WHERE p.supplier_company_id = $1 ORDER BY p.created_at DESC LIMIT 500`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.get("/products", authenticate, async (request, response) => {
  const search = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 100) : "";
  const result = await query(
    `SELECT p.id, p.sku, p.name, p.description, p.unit, p.image_url AS "imageUrl",
            p.minimum_order_quantity AS "minimumOrderQuantity", c.id AS "supplierCompanyId",
            c.display_name AS "supplierName", p.pricing_mode AS "pricingMode",
            COALESCE(c.metadata->>'demo' = 'true', false) AS "isDemo",
            CASE WHEN p.pricing_mode = 'public' THEN p.unit_price END AS "unitPrice",
            p.currency, p.production_capacity AS "productionCapacity", p.lead_time_days AS "leadTimeDays",
            p.delivery_regions AS "deliveryRegions", p.specifications,
            CASE WHEN p.pricing_mode = 'public' THEN COALESCE((
              SELECT jsonb_agg(jsonb_build_object('minimumQuantity', t.minimum_quantity, 'unitPrice', t.unit_price)
                ORDER BY t.minimum_quantity) FROM product_price_tiers t WHERE t.product_id = p.id
            ), '[]'::jsonb) ELSE '[]'::jsonb END AS "priceTiers",
            p.is_active AS "isActive", p.created_at AS "createdAt"
     FROM products p JOIN companies c ON c.id = p.supplier_company_id
     WHERE p.is_active = true AND c.status = 'active' AND c.type = 'supplier'
       AND ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR p.sku ILIKE '%' || $1 || '%'
            OR c.display_name ILIKE '%' || $1 || '%')
     ORDER BY p.created_at DESC LIMIT 200`,
    [search],
  );
  response.json({ data: result.rows });
});

router.post("/products", authenticate, requireCompany("supplier"), requireRole("owner", "admin", "manager"), async (request, response) => {
  const input = parse(z.object({
    sku: z.string().trim().max(80).optional(),
    name: textSchema(2, 200),
    description: z.string().trim().max(2000).optional(),
    unit: textSchema(1, 40),
    minimumOrderQuantity: quantitySchema.default(1),
    pricingMode: z.enum(["public", "quote"]).default("quote"),
    unitPrice: z.number().finite().nonnegative().max(1_000_000_000).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).default("SAR"),
    priceTiers: productPriceTiersSchema.default([]),
    productionCapacity: quantitySchema.optional(),
    leadTimeDays: z.number().int().min(0).max(3650).optional(),
    deliveryRegions: z.array(textSchema(2, 100)).max(100).default([]),
    specifications: productSpecificationsSchema.default({}),
  }), request.body);
  invariant(input.pricingMode !== "public" || input.unitPrice !== undefined, 400,
    "أدخل سعر الوحدة عند اختيار عرض السعر العام.", "PUBLIC_PRICE_REQUIRED");
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const result = await transaction(async (client) => {
    const product = await client.query(
      `INSERT INTO products (
         supplier_company_id, sku, name, description, unit, minimum_order_quantity, pricing_mode,
         unit_price, currency, production_capacity, lead_time_days, delivery_regions, specifications
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
       RETURNING id, sku, name, description, unit, minimum_order_quantity AS "minimumOrderQuantity",
         pricing_mode AS "pricingMode", unit_price AS "unitPrice", currency,
         production_capacity AS "productionCapacity", lead_time_days AS "leadTimeDays",
         delivery_regions AS "deliveryRegions", specifications, is_active AS "isActive", created_at AS "createdAt"`,
      [context.companyId, input.sku || null, input.name, input.description ?? null, input.unit,
        input.minimumOrderQuantity, input.pricingMode, input.unitPrice ?? null, input.currency,
        input.productionCapacity ?? null, input.leadTimeDays ?? null, [...new Set(input.deliveryRegions)],
        JSON.stringify(input.specifications)],
    );
    if (input.priceTiers.length) {
      await client.query(
        `INSERT INTO product_price_tiers (product_id, minimum_quantity, unit_price)
         SELECT $1, tier.minimum_quantity, tier.unit_price
         FROM jsonb_to_recordset($2::jsonb) AS tier(minimum_quantity numeric, unit_price numeric)`,
        [product.rows[0].id, JSON.stringify(productPriceTiers(input.priceTiers).map((tier) => ({
          minimum_quantity: tier.minimumQuantity, unit_price: tier.unitPrice,
        })))],
      );
    }
    await audit(client, context.companyId, context.userId, "product.created", "product", product.rows[0].id);
    return { ...product.rows[0], priceTiers: productPriceTiers(input.priceTiers) };
  });
  response.status(201).json(result);
});

router.patch("/products/:id", authenticate, requireCompany("supplier"), requireRole("owner", "admin", "manager"), async (request, response) => {
  const productId = parse(uuidSchema, request.params.id);
  const input = parse(z.object({
    sku: z.string().trim().max(80).nullable().optional(),
    name: textSchema(2, 200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    unit: textSchema(1, 40).optional(),
    minimumOrderQuantity: quantitySchema.optional(),
    pricingMode: z.enum(["public", "quote"]).optional(),
    unitPrice: z.number().finite().nonnegative().max(1_000_000_000).nullable().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    priceTiers: productPriceTiersSchema.optional(),
    productionCapacity: quantitySchema.nullable().optional(),
    leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
    deliveryRegions: z.array(textSchema(2, 100)).max(100).optional(),
    specifications: productSpecificationsSchema.optional(),
    isActive: z.boolean().optional(),
  }).strict(), request.body);
  invariant(Object.keys(input).length > 0, 400, "أدخل حقلًا واحدًا على الأقل للتحديث.");
  const columns = {
    sku: "sku", name: "name", description: "description", unit: "unit",
    minimumOrderQuantity: "minimum_order_quantity", isActive: "is_active",
    pricingMode: "pricing_mode", unitPrice: "unit_price", currency: "currency",
    productionCapacity: "production_capacity", leadTimeDays: "lead_time_days",
    deliveryRegions: "delivery_regions", specifications: "specifications",
  } as const;
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const updated = await transaction(async (client) => {
    const current = await client.query<{ pricing_mode: string; unit_price: string | null }>(
      "SELECT pricing_mode, unit_price FROM products WHERE id = $1 AND supplier_company_id = $2 FOR UPDATE",
      [productId, context.companyId],
    );
    invariant(current.rows[0], 404, "المنتج غير موجود في كتالوج شركتك.", "PRODUCT_NOT_FOUND");
    const nextMode = input.pricingMode ?? current.rows[0].pricing_mode;
    const nextPrice = input.unitPrice === undefined ? current.rows[0].unit_price : input.unitPrice;
    invariant(nextMode !== "public" || nextPrice !== null, 400,
      "أدخل سعر الوحدة عند اختيار عرض السعر العام.", "PUBLIC_PRICE_REQUIRED");

    const updates: string[] = [];
    const values: unknown[] = [];
    for (const key of Object.keys(columns) as Array<keyof typeof columns>) {
      const value = input[key];
      if (value !== undefined) {
        values.push(key === "specifications" ? JSON.stringify(value) : value);
        updates.push(`${columns[key]} = $${values.length}${key === "specifications" ? "::jsonb" : ""}`);
      }
    }
    if (updates.length) {
      values.push(productId, context.companyId);
      await client.query(
        `UPDATE products SET ${updates.join(", ")}
         WHERE id = $${values.length - 1} AND supplier_company_id = $${values.length}`,
        values,
      );
    }
    if (input.priceTiers !== undefined) {
      await client.query("DELETE FROM product_price_tiers WHERE product_id = $1", [productId]);
      if (input.priceTiers.length) {
        await client.query(
          `INSERT INTO product_price_tiers (product_id, minimum_quantity, unit_price)
           SELECT $1, tier.minimum_quantity, tier.unit_price
           FROM jsonb_to_recordset($2::jsonb) AS tier(minimum_quantity numeric, unit_price numeric)`,
          [productId, JSON.stringify(productPriceTiers(input.priceTiers).map((tier) => ({
            minimum_quantity: tier.minimumQuantity, unit_price: tier.unitPrice,
          })))],
        );
      }
    }
    await audit(client, context.companyId, context.userId, "product.updated", "product", productId);
    const result = await client.query(
      `SELECT id, sku, name, description, unit, minimum_order_quantity AS "minimumOrderQuantity",
              pricing_mode AS "pricingMode", unit_price AS "unitPrice", currency,
              production_capacity AS "productionCapacity", lead_time_days AS "leadTimeDays",
              delivery_regions AS "deliveryRegions", specifications, is_active AS "isActive"
       FROM products WHERE id = $1`,
      [productId],
    );
    return result.rows[0];
  });
  response.json(updated);
});

router.get("/services", authenticate, async (request, response) => {
  const result = await query(
    `SELECT s.id, s.name, s.category, s.description, s.coverage, s.price_from AS "priceFrom",
            s.currency, c.id AS "providerCompanyId", c.display_name AS "providerName"
     FROM service_listings s JOIN companies c ON c.id = s.provider_company_id
     WHERE s.is_active = true AND c.status = 'active' AND c.type = 'service_provider'
     ORDER BY s.created_at DESC LIMIT 200`,
  );
  response.json({ data: result.rows });
});

router.get("/services/mine", authenticate, requireCompany("service_provider"), async (request, response) => {
  const result = await query(
    `SELECT id, name, category, description, coverage, price_from AS "priceFrom",
            currency, is_active AS "isActive", created_at AS "createdAt"
     FROM service_listings WHERE provider_company_id = $1 ORDER BY created_at DESC LIMIT 500`,
    [request.context!.companyId],
  );
  response.json({ data: result.rows });
});

router.post("/services", authenticate, requireCompany("service_provider"), requireRole("owner", "admin", "manager"), async (request, response) => {
  const input = parse(z.object({
    name: textSchema(2, 200),
    category: textSchema(2, 100),
    description: z.string().trim().max(2000).optional(),
    coverage: z.array(textSchema(2, 100)).max(100).default([]),
    priceFrom: z.number().finite().nonnegative().max(1_000_000_000).nullable().optional(),
  }), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const result = await transaction(async (client) => {
    const listing = await client.query(
      `INSERT INTO service_listings (provider_company_id, name, category, description, coverage, price_from)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING id, name, category, description, coverage, price_from AS "priceFrom", currency, is_active AS "isActive"`,
      [context.companyId, input.name, input.category, input.description ?? null, JSON.stringify(input.coverage), input.priceFrom ?? null],
    );
    await audit(client, context.companyId, context.userId, "service.created", "service_listing", listing.rows[0].id);
    return listing.rows[0];
  });
  response.status(201).json(result);
});

router.post("/service-requests", authenticate, requireCompany("customer"), requireRole("owner", "admin", "manager", "purchaser"), async (request, response) => {
  const input = parse(z.object({
    title: textSchema(2, 200),
    description: z.string().trim().max(3000).optional(),
    city: z.string().trim().max(100).optional(),
    listingId: uuidSchema.optional(),
    providerCompanyId: uuidSchema.optional(),
    requestedAt: z.iso.datetime().optional(),
  }).strict(), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const result = await transaction(async (client) => {
    if (input.listingId) {
      const listing = await client.query(
        `SELECT id FROM service_listings WHERE id = $1 AND is_active = true
         AND ($2::uuid IS NULL OR provider_company_id = $2)`,
        [input.listingId, input.providerCompanyId ?? null],
      );
      invariant(listing.rowCount === 1, 404, "الخدمة المطلوبة غير متاحة.", "SERVICE_NOT_FOUND");
    }
    if (input.providerCompanyId) {
      const provider = await client.query(
        "SELECT id FROM companies WHERE id = $1 AND type = 'service_provider' AND status = 'active'",
        [input.providerCompanyId],
      );
      invariant(provider.rowCount === 1, 404, "مقدم الخدمة غير متاح.", "PROVIDER_NOT_FOUND");
    }
    const created = await client.query(
      `INSERT INTO service_requests (reference, customer_company_id, provider_company_id, listing_id, title, description, city, requested_at, created_by)
       VALUES ('SR-' || to_char(now(), 'YYYY') || '-' || upper(replace(gen_random_uuid()::text, '-', '')),
               $1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, reference, title, description, city, status, created_at AS "createdAt"`,
      [context.companyId, input.providerCompanyId ?? null, input.listingId ?? null, input.title, input.description ?? null, input.city ?? null, input.requestedAt ?? null, context.userId],
    );
    await audit(client, context.companyId, context.userId, "service_request.created", "service_request", created.rows[0].id);
    return created.rows[0];
  });
  response.status(201).json(result);
});

router.get("/service-requests", authenticate, async (request, response) => {
  const { companyId, companyType } = request.context!;
  const result = companyType === "service_provider"
    ? await query(
      `SELECT sr.id, sr.reference, sr.title, sr.description, sr.city, sr.status,
              c.display_name AS "customerName", sr.created_at AS "createdAt"
       FROM service_requests sr JOIN companies c ON c.id = sr.customer_company_id
       WHERE sr.provider_company_id = $1 OR (sr.provider_company_id IS NULL AND sr.status = 'open')
       ORDER BY sr.created_at DESC LIMIT 200`,
      [companyId],
    )
    : await query(
      `SELECT sr.id, sr.reference, sr.title, sr.description, sr.city, sr.status,
              c.display_name AS "providerName", sr.created_at AS "createdAt"
       FROM service_requests sr LEFT JOIN companies c ON c.id = sr.provider_company_id
       WHERE sr.customer_company_id = $1 ORDER BY sr.created_at DESC LIMIT 200`,
      [companyId],
    );
  response.json({ data: result.rows });
});

router.patch("/service-requests/:id/status", authenticate, async (request, response) => {
  const id = parse(uuidSchema, request.params.id);
  const input = parse(z.object({ status: z.enum(["accepted", "in_progress", "completed", "cancelled"]) }), request.body);
  const context = request.context!;
  await ensureCompanyActive(context.companyId);
  const result = await transaction(async (client) => {
    const current = await client.query<{ status: string; customer_company_id: string; provider_company_id: string | null }>(
      "SELECT status, customer_company_id, provider_company_id FROM service_requests WHERE id = $1 FOR UPDATE",
      [id],
    );
    const serviceRequest = current.rows[0];
    invariant(serviceRequest, 404, "طلب الخدمة غير موجود.", "SERVICE_REQUEST_NOT_FOUND");
    const isCustomer = serviceRequest.customer_company_id === context.companyId;
    const isProvider = serviceRequest.provider_company_id === context.companyId
      || (serviceRequest.provider_company_id === null && context.companyType === "service_provider"
        && input.status === "accepted" && serviceRequest.status === "open");
    invariant(isCustomer || isProvider, 403, "لا تملك صلاحية على طلب الخدمة.", "SERVICE_REQUEST_FORBIDDEN");
    invariant(
      (input.status === "accepted" && isProvider && serviceRequest.status === "open")
      || (input.status === "in_progress" && isProvider && serviceRequest.status === "accepted")
      || (input.status === "completed" && isProvider && serviceRequest.status === "in_progress")
      || (input.status === "cancelled" && isCustomer && ["open", "accepted"].includes(serviceRequest.status)),
      409,
      "تغيير الحالة غير متاح في هذه المرحلة.",
      "INVALID_STATUS_TRANSITION",
    );
    await client.query(
      `UPDATE service_requests SET status = $1,
         provider_company_id = CASE WHEN $1 = 'accepted' AND provider_company_id IS NULL THEN $2 ELSE provider_company_id END
       WHERE id = $3`,
      [input.status, context.companyId, id],
    );
    await audit(client, context.companyId, context.userId, `service_request.${input.status}`, "service_request", id);
    return { id, status: input.status };
  });
  response.json(result);
});

export default router;

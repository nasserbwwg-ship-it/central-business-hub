import { Router } from "express";
import { authenticate } from "./auth.js";
import { query } from "./db.js";
import { ApiError } from "./errors.js";

const router = Router();

router.get("/analytics/dashboard", authenticate, async (request, response) => {
  const { companyId, companyType } = request.context!;
  const isOperator = companyType === "operator";
  const result = await query(
    `SELECT
       COALESCE((SELECT jsonb_agg(jsonb_build_object('currency', totals.currency, 'amount', totals.amount) ORDER BY totals.currency)
         FROM (SELECT o.currency, sum(o.total_amount)::text AS amount FROM orders o
           WHERE o.status <> 'cancelled' AND ($1::boolean OR o.customer_company_id = $2 OR o.supplier_company_id = $2)
           GROUP BY o.currency) totals), '[]'::jsonb) AS "gmvByCurrency",
       COALESCE((SELECT jsonb_agg(jsonb_build_object('currency', totals.currency, 'amount', totals.amount) ORDER BY totals.currency)
         FROM (SELECT i.currency, sum(p.amount)::text AS amount FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
           WHERE ($1::boolean OR i.issuer_company_id = $2) AND i.status <> 'void' GROUP BY i.currency) totals), '[]'::jsonb) AS "collectedPaymentsByCurrency",
       (SELECT count(*)::int FROM companies c WHERE c.type = 'customer' AND c.status = 'active'
         AND ($1::boolean OR EXISTS (SELECT 1 FROM orders o WHERE o.customer_company_id = c.id AND (o.supplier_company_id = $2 OR $1::boolean)))) AS activeCustomers,
       (SELECT count(*)::int FROM companies c WHERE c.type = 'supplier' AND c.status = 'active'
         AND ($1::boolean OR EXISTS (SELECT 1 FROM products p WHERE p.supplier_company_id = c.id AND p.is_active))) AS activeSuppliers,
       (SELECT count(*)::int FROM rfqs r WHERE r.status IN ('open', 'reviewing', 'partially_awarded')
         AND ($1::boolean OR r.customer_company_id = $2 OR EXISTS (
           SELECT 1 FROM rfq_suppliers s WHERE s.rfq_id = r.id AND s.supplier_company_id = $2))) AS openRfqs,
       (SELECT CASE WHEN count(*) = 0 THEN 0
         ELSE round(100.0 * count(*) FILTER (WHERE s.status = 'delivered') / count(*), 2) END
         FROM shipments s WHERE ($1::boolean OR s.customer_company_id = $2 OR s.carrier_company_id = $2)) AS shipmentFulfillmentPercent,
       (SELECT CASE WHEN count(*) FILTER (WHERE s.status = 'delivered' AND s.scheduled_at IS NOT NULL) = 0 THEN NULL
         ELSE round(100.0 * count(*) FILTER (WHERE s.status = 'delivered' AND s.delivered_at <= s.scheduled_at)
           / count(*) FILTER (WHERE s.status = 'delivered' AND s.scheduled_at IS NOT NULL), 2) END
         FROM shipments s WHERE ($1::boolean OR s.customer_company_id = $2 OR s.carrier_company_id = $2)) AS onTimeDeliveryPercent,
       (SELECT CASE WHEN count(*) = 0 THEN NULL
         ELSE round(100.0 * count(*) FILTER (WHERE i.difference = 0) / count(*), 2) END
         FROM inventory_count_items i JOIN inventory_counts c ON c.id = i.count_id
         WHERE c.status = 'completed' AND ($1::boolean OR c.company_id = $2)
           AND c.created_at = (SELECT max(c2.created_at) FROM inventory_counts c2
             WHERE c2.company_id = c.company_id AND c2.warehouse_id = c.warehouse_id AND c2.status = 'completed')) AS latestInventoryAccuracyPercent,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('currency', totals.currency, 'amount', totals.amount) ORDER BY totals.currency)
         FROM (SELECT s.currency, sum(s.price_monthly)::text AS amount FROM subscriptions s
           WHERE s.status = 'active' AND ($1::boolean OR s.company_id = $2) GROUP BY s.currency) totals), '[]'::jsonb) AS "subscriptionMrrByCurrency"
     `,
    [isOperator, companyId],
  );
  response.json({
    ...result.rows[0],
    isPlatformWide: isOperator,
    revenueDefinition: "المبالغ التي سجلت الشركة استلامها يدويًا من الفواتير؛ لا تمثل GMV ولا تؤكدها جهة دفع تلقائيًا.",
    inventoryAccuracyDefinition: "نسبة أسطر آخر جرد مكتمل المطابقة تمامًا. تعرض null حتى يكتمل جرد.",
  });
});

router.get("/operations/control-tower", authenticate, async (request, response) => {
  const { companyId, companyType } = request.context!;
  const isOperator = companyType === "operator";
  if (!isOperator && !["customer", "supplier", "logistics_provider"].includes(companyType)) {
    throw new ApiError(403, "مركز العمليات غير متاح لهذا النوع من الشركات.", "COMPANY_TYPE_FORBIDDEN");
  }
  const [rfqs, shipments, claims] = await Promise.all([
    query(
      `SELECT r.id, r.reference, r.title, r.status, r.created_at AS "createdAt"
       FROM rfqs r WHERE r.status IN ('open', 'reviewing', 'partially_awarded')
         AND ($1::boolean OR r.customer_company_id = $2 OR EXISTS (
           SELECT 1 FROM rfq_suppliers s WHERE s.rfq_id = r.id AND s.supplier_company_id = $2))
       ORDER BY r.created_at LIMIT 50`,
      [isOperator, companyId],
    ),
    query(
      `SELECT s.id, s.reference, s.status, s.scheduled_at AS "scheduledAt",
              s.pickup_address AS "pickupAddress", s.delivery_address AS "deliveryAddress"
       FROM shipments s WHERE s.status NOT IN ('delivered', 'cancelled')
         AND ($1::boolean OR s.customer_company_id = $2 OR s.carrier_company_id = $2)
       ORDER BY s.scheduled_at NULLS FIRST, s.created_at LIMIT 50`,
      [isOperator, companyId],
    ),
    query(
      `SELECT c.id, c.reference, c.title, c.status, c.created_at AS "createdAt"
       FROM claims c WHERE c.status IN ('open', 'under_review')
         AND ($1::boolean OR c.claimant_company_id = $2 OR c.respondent_company_id = $2)
       ORDER BY c.created_at LIMIT 50`,
      [isOperator, companyId],
    ),
  ]);
  response.json({ openRfqs: rfqs.rows, activeShipments: shipments.rows, openClaims: claims.rows });
});

router.get("/admin/audit", authenticate, async (request, response) => {
  const { companyType, role } = request.context!;
  if (companyType !== "operator" || role !== "owner") {
    throw new ApiError(403, "سجل التدقيق متاح لمالك المنظومة فقط.", "OPERATOR_REQUIRED");
  }
  const result = await query(
    `SELECT a.id, a.company_id AS "companyId", c.display_name AS "companyName",
            a.actor_user_id AS "actorUserId", u.full_name AS "actorName", a.event_type AS "eventType",
            a.entity_type AS "entityType", a.entity_id AS "entityId", a.details, a.created_at AS "createdAt"
     FROM audit_events a LEFT JOIN companies c ON c.id = a.company_id
     LEFT JOIN users u ON u.id = a.actor_user_id
     ORDER BY a.created_at DESC LIMIT 500`,
  );
  response.json({ data: result.rows });
});

export default router;

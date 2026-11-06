import type { PoolClient } from "pg";
import { audit } from "./db.js";
import { isWithinReplenishmentLimits } from "./managed-inventory-policy.js";

export async function evaluateManagedInventory(
  client: PoolClient,
  companyId: string,
  warehouseId: string,
  actorUserId: string,
  inventoryProductId?: string,
): Promise<void> {
  const rules = await client.query<{
    service_id: string;
    rule_id: string;
    inventory_product_id: string;
    source_product_id: string | null;
    product_name: string;
    unit: string;
    supplier_company_id: string;
    reorder_below_quantity: string;
    reorder_quantity: string;
    max_unit_price: string;
    warehouse_name: string;
    warehouse_city: string;
  }>(
    `SELECT s.id AS service_id, r.id AS rule_id, r.inventory_product_id,
            p.source_product_id, p.name AS product_name, p.unit, r.supplier_company_id,
            r.reorder_below_quantity, r.reorder_quantity, r.max_unit_price,
            w.name AS warehouse_name, w.city AS warehouse_city
     FROM managed_inventory_services s
     JOIN managed_inventory_rules r ON r.service_id = s.id AND r.is_active
     JOIN inventory_products p ON p.id = r.inventory_product_id AND p.company_id = s.company_id AND p.is_active
     JOIN warehouses w ON w.id = s.warehouse_id AND w.company_id = s.company_id
     WHERE s.company_id = $1 AND s.warehouse_id = $2 AND s.status = 'active'
       AND ($3::uuid IS NULL OR r.inventory_product_id = $3)
     ORDER BY r.id`,
    [companyId, warehouseId, inventoryProductId ?? null],
  );

  for (const rule of rules.rows) {
    const balance = await client.query<{ quantity: string }>(
      `SELECT COALESCE(sum(quantity), 0)::text AS quantity
       FROM inventory_balances
       WHERE company_id = $1 AND warehouse_id = $2 AND inventory_product_id = $3`,
      [companyId, warehouseId, rule.inventory_product_id],
    );
    const quantity = Number(balance.rows[0]!.quantity);
    if (quantity > Number(rule.reorder_below_quantity)) {
      const stale = await client.query<{ rfq_id: string | null }>(
        `UPDATE managed_replenishments
         SET status = 'fulfilled', updated_at = now()
         WHERE rule_id = $1 AND status IN ('pending_quote', 'requires_approval', 'awaiting_stock', 'cancelled')
           AND (status <> 'cancelled' OR order_id IS NULL)
         RETURNING rfq_id`,
        [rule.rule_id],
      );
      for (const replenishment of stale.rows) {
        if (!replenishment.rfq_id) continue;
        await client.query(
          "UPDATE rfqs SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status IN ('open', 'reviewing', 'partially_awarded')",
          [replenishment.rfq_id],
        );
        await client.query(
          "UPDATE supplier_quotes SET status = 'withdrawn' WHERE rfq_id = $1 AND status = 'submitted'",
          [replenishment.rfq_id],
        );
      }
      continue;
    }

    const existing = await client.query<{ status: string }>(
      "SELECT status FROM managed_replenishments WHERE rule_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
      [rule.rule_id],
    );
    if (existing.rows[0] && existing.rows[0].status !== "fulfilled") continue;
    if (existing.rows[0]?.status === "cancelled") continue;

    const supplier = await client.query<{ active: boolean; minimum_order_quantity: string }>(
      `SELECT c.status = 'active' AS active, p.minimum_order_quantity
       FROM products p JOIN companies c ON c.id = p.supplier_company_id
       WHERE p.id = $1 AND p.supplier_company_id = $2 AND p.is_active`,
      [rule.source_product_id, rule.supplier_company_id],
    );
    const supplierProduct = supplier.rows[0];
    if (!rule.source_product_id || !supplierProduct?.active
      || Number(rule.reorder_quantity) < Number(supplierProduct.minimum_order_quantity)) {
      await client.query(
        `INSERT INTO managed_replenishments
         (service_id, rule_id, status, current_quantity, requested_quantity, block_reason)
         VALUES ($1, $2, 'requires_approval', $3, $4, $5)`,
        [rule.service_id, rule.rule_id, quantity, rule.reorder_quantity,
          "المورد أو المنتج غير متاح، أو أن كمية إعادة التوريد أصبحت أقل من الحد الأدنى للمورد."],
      );
      await audit(client, companyId, actorUserId, "managed_inventory.replenishment.blocked", "managed_inventory_rule", rule.rule_id);
      continue;
    }

    const rfq = await client.query<{ id: string; reference: string }>(
      `INSERT INTO rfqs (customer_company_id, title, notes, status, created_by)
       VALUES ($1, $2, $3, 'open', $4)
       RETURNING id, reference`,
      [companyId, `إعادة توريد تلقائية: ${rule.product_name}`,
        `طلب منشأ من خدمة إدارة المخزون للمستودع ${rule.warehouse_name} (${rule.warehouse_city}). الكمية المطلوبة ${rule.reorder_quantity} ${rule.unit}. الحد الأقصى للسعر ${rule.max_unit_price} ريال للوحدة.`,
        actorUserId],
    );
    await client.query(
      "INSERT INTO rfq_suppliers (rfq_id, supplier_company_id) VALUES ($1, $2)",
      [rfq.rows[0]!.id, rule.supplier_company_id],
    );
    await client.query(
      `INSERT INTO rfq_items (rfq_id, product_id, supplier_company_id, description, quantity, unit)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [rfq.rows[0]!.id, rule.source_product_id, rule.supplier_company_id, rule.product_name, rule.reorder_quantity, rule.unit],
    );
    const replenishment = await client.query<{ id: string }>(
      `INSERT INTO managed_replenishments
       (service_id, rule_id, rfq_id, status, current_quantity, requested_quantity)
       VALUES ($1, $2, $3, 'pending_quote', $4, $5)
       RETURNING id`,
      [rule.service_id, rule.rule_id, rfq.rows[0]!.id, quantity, rule.reorder_quantity],
    );
    await audit(client, companyId, actorUserId, "managed_inventory.replenishment.requested", "managed_replenishment", replenishment.rows[0]!.id, {
      rfqId: rfq.rows[0]!.id,
      reference: rfq.rows[0]!.reference,
      warehouseId,
      inventoryProductId: rule.inventory_product_id,
      quantity: rule.reorder_quantity,
    });
  }
}

export async function tryAutoAcceptManagedQuote(
  client: PoolClient,
  quoteId: string,
  rfqId: string,
  supplierCompanyId: string,
  totalAmount: string,
  currency: string,
  validUntil: string | null,
): Promise<void> {
  const replenishment = await client.query<{
    id: string;
    service_id: string;
    rule_id: string;
    company_id: string;
    per_order_budget: string;
    monthly_budget: string;
    auto_reorder: boolean;
    reorder_quantity: string;
    max_unit_price: string;
    supplier_company_id: string;
  }>(
    `SELECT mr.id, mr.service_id, mr.rule_id, s.company_id, s.per_order_budget,
            s.monthly_budget, s.auto_reorder, r.reorder_quantity, r.max_unit_price,
            r.supplier_company_id
     FROM managed_replenishments mr
     JOIN managed_inventory_services s ON s.id = mr.service_id
     JOIN companies c ON c.id = s.company_id AND c.status = 'active'
     JOIN managed_inventory_rules r ON r.id = mr.rule_id
     WHERE mr.rfq_id = $1 AND mr.status = 'pending_quote' AND s.status = 'active'
     FOR UPDATE OF mr, s, r`,
    [rfqId],
  );
  const authorized = replenishment.rows[0];
  if (!authorized || !authorized.auto_reorder || authorized.supplier_company_id !== supplierCompanyId) return;

  const monthlySpend = await client.query<{ amount: string }>(
    `SELECT COALESCE(sum(mr.authorized_amount), 0)::text AS amount
     FROM managed_replenishments mr
     JOIN orders o ON o.id = mr.order_id
     WHERE mr.service_id = $1 AND mr.status IN ('ordered', 'awaiting_stock', 'fulfilled')
       AND o.created_at >= date_trunc('month', now())`,
    [authorized.service_id],
  );
  const amount = Number(totalAmount);
  const withinLimits = isWithinReplenishmentLimits({
    quoteAmount: amount,
    currency,
    perOrderBudget: Number(authorized.per_order_budget),
    monthlyBudget: Number(authorized.monthly_budget),
    monthlySpend: Number(monthlySpend.rows[0]!.amount),
    reorderQuantity: Number(authorized.reorder_quantity),
    maxUnitPrice: Number(authorized.max_unit_price),
    validUntil,
    today: new Date().toISOString().slice(0, 10),
  });
  if (!withinLimits) {
    await client.query(
      `UPDATE managed_replenishments SET status = 'requires_approval',
         block_reason = 'عرض المورد خارج سقف الطلب أو الشهر أو سعر الوحدة، أو أن صلاحيته انتهت.',
         updated_at = now()
       WHERE id = $1`,
      [authorized.id],
    );
    await client.query(
      `INSERT INTO audit_events (company_id, event_type, entity_type, entity_id, details)
       VALUES ($1, 'managed_inventory.quote_requires_approval', 'supplier_quote', $2, $3)`,
      [authorized.company_id, quoteId, JSON.stringify({ rfqId, totalAmount, currency })],
    );
    return;
  }

  await client.query("UPDATE supplier_quotes SET status = 'accepted' WHERE id = $1 AND status = 'submitted'", [quoteId]);
  await client.query("UPDATE rfqs SET status = 'awarded', updated_at = now() WHERE id = $1", [rfqId]);
  const order = await client.query<{ id: string; reference: string }>(
    `INSERT INTO orders (rfq_id, quote_id, customer_company_id, supplier_company_id, currency, total_amount)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, reference`,
    [rfqId, quoteId, authorized.company_id, supplierCompanyId, currency, totalAmount],
  );
  await client.query(
    `UPDATE managed_replenishments
     SET status = 'ordered', order_id = $1, authorized_amount = $2, block_reason = NULL, updated_at = now()
     WHERE id = $3`,
    [order.rows[0]!.id, totalAmount, authorized.id],
  );
  await client.query(
    `INSERT INTO audit_events (company_id, event_type, entity_type, entity_id, details)
     VALUES ($1, 'managed_inventory.order_auto_created', 'order', $2, $3)`,
    [authorized.company_id, order.rows[0]!.id, JSON.stringify({ rfqId, reference: order.rows[0]!.reference, quoteId, amount: totalAmount, currency })],
  );
}

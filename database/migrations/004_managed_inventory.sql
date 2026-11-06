CREATE TABLE managed_inventory_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'quoted', 'active', 'paused', 'rejected', 'cancelled')),
  auto_reorder BOOLEAN NOT NULL DEFAULT false,
  per_order_budget NUMERIC(14, 2) NOT NULL CHECK (per_order_budget > 0),
  monthly_budget NUMERIC(14, 2) NOT NULL CHECK (monthly_budget >= per_order_budget),
  monthly_fee NUMERIC(14, 2) CHECK (monthly_fee IS NULL OR monthly_fee >= 0),
  request_notes TEXT,
  quote_notes TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  quoted_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_managed_inventory_service_per_warehouse_idx
  ON managed_inventory_services (company_id, warehouse_id)
  WHERE status IN ('requested', 'quoted', 'active', 'paused');
CREATE INDEX managed_inventory_services_company_idx
  ON managed_inventory_services (company_id, created_at DESC);

CREATE TABLE managed_inventory_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES managed_inventory_services(id) ON DELETE CASCADE,
  inventory_product_id UUID NOT NULL REFERENCES inventory_products(id),
  supplier_company_id UUID NOT NULL REFERENCES companies(id),
  reorder_below_quantity NUMERIC(14, 3) NOT NULL CHECK (reorder_below_quantity >= 0),
  reorder_quantity NUMERIC(14, 3) NOT NULL CHECK (reorder_quantity > 0),
  max_unit_price NUMERIC(14, 2) NOT NULL CHECK (max_unit_price > 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service_id, inventory_product_id),
  UNIQUE (id, service_id)
);

CREATE TABLE managed_replenishments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id UUID NOT NULL REFERENCES managed_inventory_services(id) ON DELETE CASCADE,
  rule_id UUID NOT NULL,
  rfq_id UUID UNIQUE REFERENCES rfqs(id),
  order_id UUID UNIQUE REFERENCES orders(id),
  status TEXT NOT NULL
    CHECK (status IN ('pending_quote', 'requires_approval', 'ordered', 'awaiting_stock', 'fulfilled', 'cancelled')),
  current_quantity NUMERIC(14, 3) NOT NULL CHECK (current_quantity >= 0),
  requested_quantity NUMERIC(14, 3) NOT NULL CHECK (requested_quantity > 0),
  authorized_amount NUMERIC(14, 2) CHECK (authorized_amount IS NULL OR authorized_amount >= 0),
  block_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (rule_id, service_id) REFERENCES managed_inventory_rules(id, service_id) ON DELETE CASCADE
);
CREATE INDEX managed_replenishments_service_created_idx
  ON managed_replenishments (service_id, created_at DESC);
CREATE UNIQUE INDEX one_open_managed_replenishment_per_rule_idx
  ON managed_replenishments (rule_id)
  WHERE status IN ('pending_quote', 'requires_approval', 'ordered', 'awaiting_stock');

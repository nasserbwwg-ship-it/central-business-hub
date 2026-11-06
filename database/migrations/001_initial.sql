CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE company_type AS ENUM ('customer', 'supplier', 'service_provider', 'logistics_provider', 'operator');
CREATE TYPE company_status AS ENUM ('pending', 'active', 'suspended');
CREATE TYPE membership_role AS ENUM ('owner', 'admin', 'manager', 'purchaser', 'warehouse', 'accountant', 'sales', 'driver', 'member');
CREATE TYPE rfq_status AS ENUM ('draft', 'open', 'reviewing', 'awarded', 'cancelled', 'closed');
CREATE TYPE quote_status AS ENUM ('submitted', 'accepted', 'rejected', 'withdrawn');
CREATE TYPE order_status AS ENUM ('confirmed', 'processing', 'partially_fulfilled', 'fulfilled', 'cancelled');
CREATE TYPE shipment_status AS ENUM ('pending', 'assigned', 'picked_up', 'in_transit', 'delivered', 'exception', 'cancelled');
CREATE TYPE stock_movement_type AS ENUM ('receipt', 'issue', 'transfer_in', 'transfer_out', 'adjustment');
CREATE TYPE contract_status AS ENUM ('draft', 'pending_approval', 'active', 'expired', 'terminated');
CREATE TYPE invoice_status AS ENUM ('draft', 'issued', 'partially_paid', 'paid', 'overdue', 'void');
CREATE TYPE claim_status AS ENUM ('open', 'under_review', 'resolved', 'rejected', 'closed');

CREATE SEQUENCE rfq_reference_seq;
CREATE SEQUENCE order_reference_seq;
CREATE FUNCTION next_rfq_reference() RETURNS TEXT LANGUAGE SQL VOLATILE AS $$
  SELECT 'B2B-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('rfq_reference_seq')::TEXT, 6, '0')
$$;
CREATE FUNCTION next_order_reference() RETURNS TEXT LANGUAGE SQL VOLATILE AS $$
  SELECT 'ORD-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('order_reference_seq')::TEXT, 6, '0')
$$;

CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  type company_type NOT NULL,
  status company_status NOT NULL DEFAULT 'pending',
  registration_number TEXT,
  tax_number TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE company_memberships (
  company_id UUID NOT NULL REFERENCES companies(id),
  user_id UUID NOT NULL REFERENCES users(id),
  role membership_role NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_hash TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_company_id UUID REFERENCES companies(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  address TEXT,
  is_warehouse BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_company_id UUID NOT NULL REFERENCES companies(id),
  sku TEXT,
  name TEXT NOT NULL,
  description TEXT,
  unit TEXT NOT NULL,
  minimum_order_quantity NUMERIC(14, 3) NOT NULL DEFAULT 1 CHECK (minimum_order_quantity > 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (supplier_company_id, sku)
);
CREATE INDEX products_supplier_active_idx ON products (supplier_company_id, is_active);

CREATE TABLE service_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_company_id UUID NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  coverage JSONB NOT NULL DEFAULT '[]'::jsonb,
  price_from NUMERIC(14, 2) CHECK (price_from IS NULL OR price_from >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'SAR',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE service_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  customer_company_id UUID NOT NULL REFERENCES companies(id),
  provider_company_id UUID REFERENCES companies(id),
  listing_id UUID REFERENCES service_listings(id),
  title TEXT NOT NULL,
  description TEXT,
  city TEXT,
  requested_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'in_progress', 'completed', 'cancelled')),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rfqs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE DEFAULT next_rfq_reference(),
  customer_company_id UUID NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  notes TEXT,
  status rfq_status NOT NULL DEFAULT 'draft',
  response_due_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rfqs_customer_status_created_idx ON rfqs (customer_company_id, status, created_at DESC);

CREATE TABLE rfq_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id UUID NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  description TEXT NOT NULL,
  quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL
);

CREATE TABLE rfq_suppliers (
  rfq_id UUID NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  supplier_company_id UUID NOT NULL REFERENCES companies(id),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rfq_id, supplier_company_id)
);
CREATE INDEX rfq_suppliers_supplier_idx ON rfq_suppliers (supplier_company_id, invited_at DESC);

CREATE TABLE supplier_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id UUID NOT NULL REFERENCES rfqs(id),
  supplier_company_id UUID NOT NULL REFERENCES companies(id),
  status quote_status NOT NULL DEFAULT 'submitted',
  currency CHAR(3) NOT NULL DEFAULT 'SAR',
  total_amount NUMERIC(14, 2) NOT NULL CHECK (total_amount >= 0),
  valid_until DATE,
  notes TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, supplier_company_id)
);
CREATE INDEX quotes_supplier_submitted_idx ON supplier_quotes (supplier_company_id, submitted_at DESC);
CREATE UNIQUE INDEX one_accepted_quote_per_rfq_idx ON supplier_quotes (rfq_id) WHERE status = 'accepted';

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE DEFAULT next_order_reference(),
  rfq_id UUID NOT NULL UNIQUE REFERENCES rfqs(id),
  quote_id UUID NOT NULL UNIQUE REFERENCES supplier_quotes(id),
  customer_company_id UUID NOT NULL REFERENCES companies(id),
  supplier_company_id UUID NOT NULL REFERENCES companies(id),
  status order_status NOT NULL DEFAULT 'confirmed',
  currency CHAR(3) NOT NULL DEFAULT 'SAR',
  total_amount NUMERIC(14, 2) NOT NULL CHECK (total_amount >= 0),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_customer_created_idx ON orders (customer_company_id, created_at DESC);
CREATE INDEX orders_supplier_created_idx ON orders (supplier_company_id, created_at DESC);

CREATE TABLE warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id),
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE inventory_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_product_id UUID REFERENCES products(id),
  barcode TEXT,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  low_stock_threshold NUMERIC(14, 3) NOT NULL DEFAULT 0 CHECK (low_stock_threshold >= 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, name, unit)
);
CREATE UNIQUE INDEX inventory_products_company_barcode_idx
  ON inventory_products (company_id, barcode) WHERE barcode IS NOT NULL;

CREATE TABLE stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  product_id UUID REFERENCES products(id),
  inventory_product_id UUID REFERENCES inventory_products(id),
  product_name TEXT NOT NULL,
  movement_type stock_movement_type NOT NULL,
  quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
  is_increase BOOLEAN NOT NULL DEFAULT false,
  unit TEXT NOT NULL,
  batch_number TEXT,
  expires_on DATE,
  reference TEXT,
  notes TEXT,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_company_warehouse_created_idx ON stock_movements (company_id, warehouse_id, created_at DESC);

CREATE TABLE inventory_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE TABLE inventory_count_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  count_id UUID NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id),
  inventory_product_id UUID REFERENCES inventory_products(id),
  product_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  batch_number TEXT,
  expires_on DATE,
  expected_quantity NUMERIC(14, 3) NOT NULL,
  counted_quantity NUMERIC(14, 3) NOT NULL CHECK (counted_quantity >= 0),
  difference NUMERIC(14, 3) NOT NULL,
  UNIQUE (count_id, product_name, unit, batch_number, expires_on)
);

CREATE TABLE carrier_profiles (
  company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  coverage_cities TEXT[] NOT NULL DEFAULT '{}',
  transport_types TEXT[] NOT NULL DEFAULT '{ambient}',
  temperature_capabilities TEXT[] NOT NULL DEFAULT '{ambient}',
  max_payload_kg NUMERIC(14, 3) CHECK (max_payload_kg IS NULL OR max_payload_kg > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE carrier_vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vehicle_type TEXT NOT NULL,
  plate_number TEXT NOT NULL,
  max_payload_kg NUMERIC(14, 3) NOT NULL CHECK (max_payload_kg > 0),
  temperature_capabilities TEXT[] NOT NULL DEFAULT '{ambient}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, plate_number)
);
CREATE INDEX carrier_vehicles_company_active_idx ON carrier_vehicles (company_id, is_active);

CREATE TABLE shipments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  order_id UUID REFERENCES orders(id),
  customer_company_id UUID NOT NULL REFERENCES companies(id),
  carrier_company_id UUID REFERENCES companies(id),
  carrier_vehicle_id UUID REFERENCES carrier_vehicles(id),
  driver_user_id UUID REFERENCES users(id),
  estimated_weight_kg NUMERIC(14, 3) CHECK (estimated_weight_kg IS NULL OR estimated_weight_kg > 0),
  status shipment_status NOT NULL DEFAULT 'pending',
  temperature_requirement TEXT CHECK (temperature_requirement IN ('ambient', 'chilled', 'frozen')),
  pickup_city TEXT NOT NULL,
  delivery_city TEXT NOT NULL,
  pickup_address TEXT NOT NULL,
  delivery_address TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  proof_of_delivery_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX shipments_customer_status_idx ON shipments (customer_company_id, status, created_at DESC);
CREATE INDEX shipments_carrier_status_idx ON shipments (carrier_company_id, status, created_at DESC);

CREATE TABLE shipment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  status shipment_status NOT NULL,
  location TEXT,
  notes TEXT,
  actor_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  customer_company_id UUID NOT NULL REFERENCES companies(id),
  counterparty_company_id UUID NOT NULL REFERENCES companies(id),
  order_id UUID REFERENCES orders(id),
  title TEXT NOT NULL,
  terms TEXT NOT NULL,
  status contract_status NOT NULL DEFAULT 'draft',
  starts_on DATE,
  ends_on DATE,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX contracts_parties_created_idx ON contracts (customer_company_id, counterparty_company_id, created_at DESC);
CREATE TABLE contract_signatures (
  contract_id UUID NOT NULL REFERENCES contracts(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  signed_by UUID NOT NULL REFERENCES users(id),
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contract_id, company_id)
);

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  issuer_company_id UUID NOT NULL REFERENCES companies(id),
  customer_company_id UUID NOT NULL REFERENCES companies(id),
  order_id UUID REFERENCES orders(id),
  status invoice_status NOT NULL DEFAULT 'draft',
  currency CHAR(3) NOT NULL DEFAULT 'SAR',
  subtotal NUMERIC(14, 2) NOT NULL CHECK (subtotal >= 0),
  tax_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount NUMERIC(14, 2) NOT NULL CHECK (total_amount >= 0),
  due_on DATE,
  issued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (total_amount = subtotal + tax_amount)
);
CREATE INDEX invoices_parties_created_idx ON invoices (issuer_company_id, customer_company_id, created_at DESC);

CREATE TABLE invoice_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL,
  external_reference TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by UUID NOT NULL REFERENCES users(id)
);

CREATE TABLE claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  order_id UUID REFERENCES orders(id),
  shipment_id UUID REFERENCES shipments(id),
  claimant_company_id UUID NOT NULL REFERENCES companies(id),
  respondent_company_id UUID NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status claim_status NOT NULL DEFAULT 'open',
  resolution TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX claims_parties_status_idx ON claims (claimant_company_id, respondent_company_id, status, created_at DESC);

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  plan_code TEXT NOT NULL CHECK (plan_code IN ('customer_business', 'inventory_basic', 'inventory_business', 'inventory_enterprise', 'procurement', 'logistics', 'supplier_premium', 'enterprise')),
  status TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled')),
  price_monthly NUMERIC(14, 2) NOT NULL CHECK (price_monthly >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'SAR',
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ
);
CREATE INDEX subscriptions_company_status_idx ON subscriptions (company_id, status);
CREATE UNIQUE INDEX one_live_subscription_per_company_idx
  ON subscriptions (company_id) WHERE status IN ('trialing', 'active', 'past_due');

CREATE TABLE integration_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  integration_type TEXT NOT NULL CHECK (integration_type IN ('erp', 'pos', 'accounting', 'shipping', 'barcode', 'other')),
  name TEXT NOT NULL,
  endpoint_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled', 'error')),
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id UUID REFERENCES companies(id),
  actor_user_id UUID REFERENCES users(id),
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_company_created_idx ON audit_events (company_id, created_at DESC);

CREATE VIEW inventory_balances AS
SELECT
  company_id,
  warehouse_id,
  product_id,
  inventory_product_id,
  product_name,
  unit,
  batch_number,
  expires_on,
  SUM(CASE WHEN movement_type IN ('receipt', 'transfer_in') OR (movement_type = 'adjustment' AND is_increase) THEN quantity ELSE -quantity END) AS quantity
FROM stock_movements
GROUP BY company_id, warehouse_id, product_id, inventory_product_id, product_name, unit, batch_number, expires_on;

CREATE VIEW finance_company_revenue AS
SELECT issuer_company_id AS company_id, currency, SUM(total_amount) AS gross_invoiced
FROM invoices
WHERE status <> 'void'
GROUP BY issuer_company_id, currency;

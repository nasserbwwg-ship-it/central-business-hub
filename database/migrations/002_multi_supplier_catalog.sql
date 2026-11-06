ALTER TYPE rfq_status ADD VALUE 'partially_awarded';

ALTER TABLE products
  ADD COLUMN pricing_mode TEXT NOT NULL DEFAULT 'quote'
    CHECK (pricing_mode IN ('public', 'quote')),
  ADD COLUMN unit_price NUMERIC(14, 2)
    CHECK (unit_price IS NULL OR unit_price >= 0),
  ADD COLUMN currency CHAR(3) NOT NULL DEFAULT 'SAR'
    CHECK (currency ~ '^[A-Z]{3}$'),
  ADD COLUMN production_capacity NUMERIC(14, 3)
    CHECK (production_capacity IS NULL OR production_capacity > 0),
  ADD COLUMN lead_time_days INTEGER
    CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 3650),
  ADD COLUMN delivery_regions TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN specifications JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT products_public_price_required
    CHECK (pricing_mode <> 'public' OR unit_price IS NOT NULL),
  ADD CONSTRAINT products_specifications_object
    CHECK (jsonb_typeof(specifications) = 'object');

CREATE TABLE product_price_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  minimum_quantity NUMERIC(14, 3) NOT NULL CHECK (minimum_quantity > 0),
  unit_price NUMERIC(14, 2) NOT NULL CHECK (unit_price >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, minimum_quantity)
);

ALTER TABLE rfq_items
  ADD COLUMN supplier_company_id UUID REFERENCES companies(id);

UPDATE rfq_items i
SET supplier_company_id = p.supplier_company_id
FROM products p
WHERE i.product_id = p.id;

ALTER TABLE orders DROP CONSTRAINT orders_rfq_id_key;
DROP INDEX one_accepted_quote_per_rfq_idx;
CREATE INDEX orders_rfq_created_idx ON orders (rfq_id, created_at DESC);

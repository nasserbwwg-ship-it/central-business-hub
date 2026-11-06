import "dotenv/config";
import { pool, transaction } from "./db.js";

type DemoProduct = {
  sku: string;
  name: string;
  description: string;
  unit: string;
  minimumOrderQuantity: number;
  pricingMode: "public" | "quote";
  unitPrice?: number;
  productionCapacity: number;
  leadTimeDays: number;
  deliveryRegions: string[];
  specifications: Record<string, string | number | boolean>;
  imageUrl: string;
};

const suppliers: Array<{ key: string; name: string; products: DemoProduct[] }> = [
  {
    key: "showcase-food-supplier",
    name: "مورد الضيافة (بيانات تجريبية)",
    products: [
      {
        sku: "DEMO-WATER-330",
        name: "مياه شرب معبأة 330 مل",
        description: "منتج وبيانات عرض تجريبية؛ الصورة توضيحية والسعر والقدرة الإنتاجية غير حقيقيين.",
        unit: "كرتون",
        minimumOrderQuantity: 10,
        pricingMode: "public",
        unitPrice: 18,
        productionCapacity: 5000,
        leadTimeDays: 3,
        deliveryRegions: ["الرياض", "جدة", "الدمام"],
        specifications: { "حجم العبوة": "330 مل", "عدد العبوات": 24, "نوع البيانات": "تجريبية" },
        imageUrl: "/demo-products/bottled-water.jpg",
      },
      {
        sku: "DEMO-COFFEE-ARAB",
        name: "قهوة عربية محمصة",
        description: "عينة كتالوج لتوضيح عرض منتجات المصانع، ولا تمثل منتجًا أو موردًا حقيقيًا.",
        unit: "كجم",
        minimumOrderQuantity: 5,
        pricingMode: "public",
        unitPrice: 74,
        productionCapacity: 700,
        leadTimeDays: 5,
        deliveryRegions: ["الرياض", "جدة"],
        specifications: { "نوع التحميص": "متوسط", "الوزن": "1 كجم", "نوع البيانات": "تجريبية" },
        imageUrl: "/demo-products/arabic-coffee.jpg",
      },
      {
        sku: "DEMO-OIL-OLIVE",
        name: "زيت زيتون بكر ممتاز",
        description: "بيانات وأسعار افتراضية لأغراض العرض فقط؛ تحقق من مواصفات المنتج الحقيقي قبل الشراء.",
        unit: "كرتون",
        minimumOrderQuantity: 4,
        pricingMode: "quote",
        productionCapacity: 350,
        leadTimeDays: 7,
        deliveryRegions: ["الرياض", "مكة المكرمة", "المدينة المنورة"],
        specifications: { "حجم العبوة": "750 مل", "عدد العبوات": 12, "نوع البيانات": "تجريبية" },
        imageUrl: "/demo-products/olive-oil.jpg",
      },
    ],
  },
  {
    key: "showcase-general-supplier",
    name: "مصنع النماذج المتنوعة (بيانات تجريبية)",
    products: [
      {
        sku: "DEMO-BAKERY-BREAD",
        name: "مخبوزات يومية متنوعة",
        description: "صورة وبيانات توضيحية لشرح كتالوج التوريد؛ ليست عرضًا تجاريًا فعليًا.",
        unit: "صندوق",
        minimumOrderQuantity: 8,
        pricingMode: "public",
        unitPrice: 42,
        productionCapacity: 1200,
        leadTimeDays: 2,
        deliveryRegions: ["الرياض", "القصيم"],
        specifications: { "التعبئة": "صندوق متنوع", "التحضير": "يومي", "نوع البيانات": "تجريبية" },
        imageUrl: "/demo-products/bakery-bread.jpg",
      },
      {
        sku: "DEMO-SOAP-LIQUID",
        name: "صابون سائل لليدين",
        description: "عينة افتراضية لواجهة العرض؛ الصورة توضيحية والمواصفات غير معتمدة.",
        unit: "كرتون",
        minimumOrderQuantity: 6,
        pricingMode: "public",
        unitPrice: 96,
        productionCapacity: 900,
        leadTimeDays: 4,
        deliveryRegions: ["الرياض", "جدة", "الخبر"],
        specifications: { "حجم العبوة": "500 مل", "عدد العبوات": 12, "نوع البيانات": "تجريبية" },
        imageUrl: "/demo-products/hand-soap.jpg",
      },
      {
        sku: "DEMO-GLOVES-NITRILE",
        name: "قفازات نيتريل للاستعمال الواحد",
        description: "بيانات تجريبية لا تمثل اعتمادًا طبيًا أو مواصفات منتج حقيقي.",
        unit: "صندوق",
        minimumOrderQuantity: 20,
        pricingMode: "quote",
        productionCapacity: 3000,
        leadTimeDays: 6,
        deliveryRegions: ["الرياض", "جدة", "الدمام"],
        specifications: { "الخامة": "نيتريل", "عدد الأزواج": 100, "نوع البيانات": "تجريبية" },
        imageUrl: "/demo-products/medical-gloves.jpg",
      },
    ],
  },
];

async function seedDemoCatalog(): Promise<void> {
  if (process.env.DEMO_DATA_ENABLED !== "true") {
    throw new Error("Set DEMO_DATA_ENABLED=true to seed the explicitly fictional demo catalog.");
  }

  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [8_674_213_095]);
    for (const supplier of suppliers) {
      const existing = await client.query<{ id: string }>(
        "SELECT id FROM companies WHERE metadata->>'demoKey' = $1 FOR UPDATE",
        [supplier.key],
      );
      const company = existing.rows[0] ?? (await client.query<{ id: string }>(
        `INSERT INTO companies (legal_name, display_name, type, status, metadata)
         VALUES ($1, $1, 'supplier', 'active', $2::jsonb)
         RETURNING id`,
        [supplier.name, JSON.stringify({ demo: true, demoKey: supplier.key })],
      )).rows[0];
      if (!company) throw new Error(`Could not create or find demo supplier ${supplier.key}.`);

      await client.query(
        `UPDATE companies
         SET legal_name = $2, display_name = $2, type = 'supplier', status = 'active',
             metadata = metadata || $3::jsonb
         WHERE id = $1`,
        [company.id, supplier.name, JSON.stringify({ demo: true, demoKey: supplier.key })],
      );

      for (const product of supplier.products) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO products (
             supplier_company_id, sku, name, description, unit, minimum_order_quantity, pricing_mode,
             unit_price, currency, production_capacity, lead_time_days, delivery_regions, specifications, image_url, is_active
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'SAR', $9, $10, $11, $12::jsonb, $13, true)
           ON CONFLICT (supplier_company_id, sku) DO UPDATE SET
             name = EXCLUDED.name,
             description = EXCLUDED.description,
             unit = EXCLUDED.unit,
             minimum_order_quantity = EXCLUDED.minimum_order_quantity,
             pricing_mode = EXCLUDED.pricing_mode,
             unit_price = EXCLUDED.unit_price,
             currency = EXCLUDED.currency,
             production_capacity = EXCLUDED.production_capacity,
             lead_time_days = EXCLUDED.lead_time_days,
             delivery_regions = EXCLUDED.delivery_regions,
             specifications = EXCLUDED.specifications,
             image_url = EXCLUDED.image_url,
             is_active = true
           RETURNING id`,
          [
            company.id, product.sku, product.name, product.description, product.unit,
            product.minimumOrderQuantity, product.pricingMode, product.unitPrice ?? null,
            product.productionCapacity, product.leadTimeDays, product.deliveryRegions,
            JSON.stringify(product.specifications), product.imageUrl,
          ],
        );
        if (product.pricingMode === "public") {
          await client.query(
            `INSERT INTO product_price_tiers (product_id, minimum_quantity, unit_price)
             VALUES ($1, $2, $3)
             ON CONFLICT (product_id, minimum_quantity) DO UPDATE SET unit_price = EXCLUDED.unit_price`,
            [inserted.rows[0]!.id, product.minimumOrderQuantity * 10, (product.unitPrice ?? 0) * 0.95],
          );
        }
      }
    }
  });
  console.log(`Seeded ${suppliers.length} clearly labeled demo suppliers and ${suppliers.reduce((count, item) => count + item.products.length, 0)} demo products.`);
}

seedDemoCatalog().catch((error: unknown) => {
  console.error("Demo catalog seeding failed", error);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});

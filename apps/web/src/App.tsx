import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { apiRequest } from "./api";

type CompanyType = "customer" | "supplier" | "service_provider" | "logistics_provider" | "operator";
type SectionId =
  | "overview" | "customers" | "suppliers" | "services" | "procurement" | "logistics"
  | "inventory" | "contracts" | "finance" | "claims" | "operations" | "analytics"
  | "integrations" | "administration";
type DataRow = Record<string, unknown>;

type UserSession = {
  user: { id: string; fullName: string; email: string };
  activeCompany: { id: string; displayName: string; type: CompanyType; status: string; role: string };
  memberships: Array<{ company_id: string; display_name: string; type: CompanyType; status: string; role: string }>;
};

type PublicProduct = {
  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  imageUrl: string | null;
  isDemo: boolean;
  unit: string;
  minimumOrderQuantity: number | string;
  supplierCompanyId: string;
  supplierName: string;
  pricingMode: "public" | "quote";
  unitPrice: number | string | null;
  currency: string;
  priceTiers: Array<{ minimumQuantity: number | string; unitPrice: number | string }>;
  productionCapacity: number | string | null;
  leadTimeDays: number | null;
  deliveryRegions: string[];
  specifications: Record<string, string | number | boolean>;
};

type PublicService = {
  id: string;
  name: string;
  category: string;
  description: string | null;
  coverage: string[] | string | null;
  priceFrom: number | string | null;
  currency: string;
  providerCompanyId: string;
  providerName: string;
};

type BasketItem = { product: PublicProduct; quantity: number };

type FieldDefinition = {
  key: string;
  label: string;
  type?: "text" | "email" | "number" | "money" | "date" | "datetime" | "textarea" | "select" | "multi" | "url" | "json";
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  optionsEndpoint?: string;
  hint?: string;
  min?: number;
};

type FormDefinition = {
  id: string;
  title: string;
  endpoint: string;
  fields: FieldDefinition[];
  itemRows?: boolean;
};

type DataSource = {
  id: string;
  title: string;
  endpoint: string;
  columns?: string[];
  responseKey?: string;
};

const navigation: Array<{ id: SectionId; label: string; group: string; icon: string; companies: CompanyType[] }> = [
  { id: "overview", label: "لوحة المتابعة", group: "الرئيسية", icon: "▦", companies: ["customer", "supplier", "service_provider", "logistics_provider", "operator"] },
  { id: "customers", label: "الشركات والعملاء", group: "المنصات التجارية", icon: "♙", companies: ["customer"] },
  { id: "suppliers", label: "الموردون والكتالوج", group: "المنصات التجارية", icon: "▤", companies: ["supplier", "customer", "operator"] },
  { id: "services", label: "الخدمات", group: "المنصات التجارية", icon: "✳", companies: ["service_provider", "customer", "operator"] },
  { id: "procurement", label: "الطلبات والعروض", group: "دورة الأعمال", icon: "▧", companies: ["customer", "supplier", "operator"] },
  { id: "logistics", label: "النقل والشحن", group: "دورة الأعمال", icon: "⇢", companies: ["customer", "logistics_provider", "operator"] },
  { id: "inventory", label: "المخزون والجرد", group: "دورة الأعمال", icon: "▣", companies: ["customer", "operator"] },
  { id: "contracts", label: "العقود", group: "دورة الأعمال", icon: "▱", companies: ["customer", "supplier", "service_provider", "logistics_provider", "operator"] },
  { id: "finance", label: "الفوترة والاشتراكات", group: "الإدارة", icon: "ر", companies: ["customer", "supplier", "service_provider", "logistics_provider", "operator"] },
  { id: "claims", label: "الشكاوى والمطالبات", group: "الإدارة", icon: "!", companies: ["customer", "supplier", "logistics_provider", "operator"] },
  { id: "operations", label: "مركز العمليات", group: "الإدارة", icon: "⌖", companies: ["customer", "supplier", "logistics_provider", "operator"] },
  { id: "analytics", label: "التقارير والتحليلات", group: "الإدارة", icon: "⌁", companies: ["customer", "supplier", "service_provider", "logistics_provider", "operator"] },
  { id: "integrations", label: "تكامل الأنظمة", group: "الإدارة", icon: "⎋", companies: ["customer", "supplier", "service_provider", "logistics_provider", "operator"] },
  { id: "administration", label: "إدارة المنظومة", group: "المنصة", icon: "⚙", companies: ["operator"] },
];

const titles: Record<SectionId, { title: string; description: string }> = {
  overview: { title: "لوحة المتابعة", description: "مؤشرات مستخرجة من سجلات قاعدة البيانات." },
  customers: { title: "الشركات والعملاء", description: "بيانات المنشأة والفروع وعضويات الشركة." },
  suppliers: { title: "الموردون والكتالوج", description: "إدارة منتجات منشأتك أو تصفح الكتالوج المعتمد." },
  services: { title: "الخدمات", description: "كتالوج الخدمات المهنية والطلبات المرتبطة بها." },
  procurement: { title: "الطلبات والعروض", description: "طلبات الأسعار والعروض وأوامر الشراء." },
  logistics: { title: "النقل والشحن", description: "توافق الناقلين ومسار الشحنة وإثبات التسليم." },
  inventory: { title: "المخزون والجرد", description: "المستودعات والباركود وحركات الأصناف والجرد." },
  contracts: { title: "العقود", description: "توثيق موافقة الطرفين على بنود الاتفاقية." },
  finance: { title: "الفوترة والاشتراكات", description: "اطلب إدارة تشغيلية للمخزون والتوريد، أو تابع الفواتير والاشتراكات. رسوم الخدمة تُعرض للموافقة ولا يوجد تحصيل آلي." },
  claims: { title: "الشكاوى والمطالبات", description: "متابعة المطالبات المرتبطة بأمر شراء أو شحنة." },
  operations: { title: "مركز العمليات", description: "استثناءات الطلبات والشحنات والمطالبات المفتوحة." },
  analytics: { title: "التقارير والتحليلات", description: "المشتريات والإيراد المحصل والوفاء بالطلبات." },
  integrations: { title: "تكامل الأنظمة", description: "تسجيل إعدادات الربط دون تخزين أسرار أو إرسال بيانات خارجية." },
  administration: { title: "إدارة المنظومة", description: "اعتماد الشركات، مراجعة سجل التدقيق، وتسعير طلبات إدارة المخزون والتوريد." },
};

const sources: Partial<Record<SectionId, DataSource[]>> = {
  customers: [
    { id: "company", title: "ملف الشركة", endpoint: "/companies/me", columns: ["displayName", "legalName", "type", "status", "registrationNumber", "taxNumber", "contactEmail", "contactPhone", "createdAt"] },
    { id: "members", title: "أعضاء الشركة", endpoint: "/companies/me/members", columns: ["fullName", "email", "role", "joinedAt"] },
    { id: "branches", title: "الفروع والمستودعات", endpoint: "/companies/me/branches", columns: ["name", "city", "address", "isWarehouse", "createdAt"] },
  ],
  suppliers: [
    { id: "products", title: "كتالوج شركتك", endpoint: "/products/mine", columns: ["name", "sku", "unit", "minimumOrderQuantity", "isActive", "createdAt"] },
    { id: "directory", title: "منتجات الموردين المعتمدين", endpoint: "/products", columns: ["name", "sku", "unit", "minimumOrderQuantity", "supplierName"] },
  ],
  services: [
    { id: "listings", title: "كتالوج خدمات شركتك", endpoint: "/services/mine", columns: ["name", "category", "coverage", "priceFrom", "isActive"] },
    { id: "marketplace", title: "الخدمات المتاحة", endpoint: "/services", columns: ["name", "category", "providerName", "coverage", "priceFrom"] },
    { id: "serviceRequests", title: "طلبات الخدمات", endpoint: "/service-requests", columns: ["reference", "title", "customerName", "providerName", "city", "status", "createdAt"] },
  ],
  procurement: [
    { id: "rfqs", title: "طلبات عروض الأسعار", endpoint: "/rfqs", columns: ["reference", "title", "customerName", "status", "quoteCount", "createdAt"] },
    { id: "orders", title: "أوامر الشراء", endpoint: "/orders", columns: ["reference", "requestTitle", "status", "currency", "totalAmount", "confirmedAt"] },
  ],
  logistics: [
    { id: "shipments", title: "الشحنات", endpoint: "/shipments", columns: ["reference", "customerName", "carrierName", "pickupCity", "deliveryCity", "temperatureRequirement", "status", "scheduledAt"] },
    { id: "carrierProfile", title: "تغطية شركة النقل", endpoint: "/logistics/profile", columns: ["coverageCities", "transportTypes", "temperatureCapabilities", "maxPayloadKg", "updatedAt"] },
    { id: "vehicles", title: "المركبات", endpoint: "/logistics/vehicles", columns: ["vehicleType", "plateNumber", "maxPayloadKg", "temperatureCapabilities", "isActive"] },
    { id: "drivers", title: "السائقون المسجلون", endpoint: "/logistics/drivers", columns: ["fullName", "email"] },
  ],
  inventory: [
    { id: "warehouses", title: "المستودعات", endpoint: "/inventory/warehouses", columns: ["name", "city", "createdAt"] },
    { id: "inventoryProducts", title: "الأصناف والباركود", endpoint: "/inventory/products", columns: ["name", "barcode", "unit", "lowStockThreshold", "isActive"] },
    { id: "balances", title: "الأرصدة الحالية", endpoint: "/inventory/balances", columns: ["warehouseName", "productName", "unit", "batchNumber", "expiresOn", "quantity"] },
    { id: "movements", title: "حركات المخزون", endpoint: "/inventory/movements", columns: ["warehouseName", "productName", "movementType", "quantity", "unit", "reference", "createdBy", "createdAt"] },
    { id: "counts", title: "جلسات الجرد", endpoint: "/inventory/counts", columns: ["warehouseName", "status", "itemCount", "discrepancyCount", "createdAt", "completedAt"] },
    { id: "alerts", title: "تنبيهات المخزون", endpoint: "/inventory/alerts", responseKey: "inventoryAlerts" },
    { id: "managedReplenishments", title: "متابعة إعادة التوريد الآلية", endpoint: "/managed-inventory/replenishments", columns: ["warehouseName", "productName", "currentQuantity", "requestedQuantity", "status", "rfqReference", "orderReference", "authorizedAmount", "blockReason", "createdAt"] },
  ],
  contracts: [{ id: "contracts", title: "العقود والاتفاقيات", endpoint: "/contracts", columns: ["reference", "title", "customerName", "counterpartyName", "signatureCount", "status", "startsOn", "endsOn"] }],
  finance: [
    { id: "invoices", title: "الفواتير", endpoint: "/invoices", columns: ["reference", "issuerName", "customerName", "status", "subtotal", "taxAmount", "totalAmount", "paidAmount", "dueOn"] },
    { id: "subscriptions", title: "اشتراكات الشركة", endpoint: "/subscriptions", columns: ["planCode", "status", "priceMonthly", "currency", "startsAt", "endsAt"] },
    { id: "managedServices", title: "خدمة إدارة المخزون والتوريد", endpoint: "/managed-inventory/services", columns: ["warehouseName", "status", "autoReorder", "perOrderBudget", "monthlyBudget", "monthlyFee", "quoteNotes", "createdAt"] },
    { id: "managedRules", title: "حدود الأصناف والموردين المصرح بهم", endpoint: "/managed-inventory/rules", columns: ["productName", "supplierName", "reorderBelowQuantity", "reorderQuantity", "maxUnitPrice", "isActive"] },
    { id: "managedReplenishments", title: "متابعة طلبات إعادة التوريد", endpoint: "/managed-inventory/replenishments", columns: ["warehouseName", "productName", "currentQuantity", "requestedQuantity", "status", "rfqReference", "orderReference", "authorizedAmount", "blockReason", "createdAt"] },
  ],
  claims: [{ id: "claims", title: "الشكاوى والمطالبات", endpoint: "/claims", columns: ["reference", "title", "claimantName", "respondentName", "status", "createdAt", "resolvedAt"] }],
  operations: [{ id: "controlTower", title: "العناصر المفتوحة", endpoint: "/operations/control-tower", responseKey: "controlTower", columns: ["_group", "reference", "title", "status", "createdAt"] }],
  analytics: [{ id: "dashboard", title: "المؤشرات المحاسبية والتشغيلية", endpoint: "/analytics/dashboard" }],
  integrations: [{ id: "integrations", title: "إعدادات الربط", endpoint: "/integrations", columns: ["name", "integrationType", "endpointUrl", "status", "configuration", "createdAt"] }],
  administration: [
    { id: "demoData", title: "البيانات التجريبية", endpoint: "/admin/demo-data", columns: ["status", "companyCount", "productCount", "description"] },
    { id: "companies", title: "الشركات والاعتمادات", endpoint: "/admin/companies", columns: ["displayName", "legalName", "type", "status", "registrationNumber", "taxNumber", "contactEmail", "createdAt"] },
    { id: "managedServiceRequests", title: "طلبات إدارة المخزون والتوريد", endpoint: "/admin/managed-inventory", columns: ["customerName", "warehouseName", "warehouseCity", "status", "ruleCount", "scopeSummary", "autoReorder", "perOrderBudget", "monthlyBudget", "monthlyFee", "requestNotes", "quoteNotes", "createdAt"] },
    { id: "managedReplenishments", title: "مراقبة إعادة التوريد", endpoint: "/admin/managed-inventory/replenishments", columns: ["customerName", "warehouseName", "productName", "currentQuantity", "requestedQuantity", "status", "rfqReference", "orderReference", "authorizedAmount", "blockReason", "createdAt"] },
    { id: "audit", title: "سجل التدقيق", endpoint: "/admin/audit", columns: ["companyName", "actorName", "eventType", "entityType", "entityId", "details", "createdAt"] },
  ],
};

const field = (key: string, label: string, type: FieldDefinition["type"] = "text", required = false, hint?: string): FieldDefinition =>
  ({ key, label, type, required, ...(hint ? { hint } : {}) });
const choiceField = (key: string, label: string, options: Array<{ value: string; label: string }>, required = true): FieldDefinition =>
  ({ key, label, type: "select", options, required });
const sourceField = (key: string, label: string, endpoint: string, required = false, multiple = false): FieldDefinition =>
  ({ key, label, type: multiple ? "multi" : "select", optionsEndpoint: endpoint, required });

const formCatalog: Record<string, FormDefinition> = {
  profile: { id: "profile", title: "تحديث بيانات الشركة", endpoint: "/companies/me", fields: [
    field("displayName", "الاسم التجاري"), field("contactEmail", "بريد التواصل", "email"),
    field("contactPhone", "رقم التواصل"), field("registrationNumber", "السجل التجاري"),
    field("taxNumber", "الرقم الضريبي"),
  ] },
  member: { id: "member", title: "إضافة عضو مسجل للشركة", endpoint: "/companies/me/members", fields: [
    field("email", "بريد المستخدم المسجل", "email", true),
    choiceField("role", "الدور", [
      { value: "admin", label: "مدير" }, { value: "manager", label: "مدير عمليات" },
      { value: "purchaser", label: "مشتريات" }, { value: "warehouse", label: "مستودع" },
      { value: "accountant", label: "محاسبة" }, { value: "sales", label: "مبيعات" },
      { value: "driver", label: "سائق" }, { value: "member", label: "عضو" },
    ]),
  ] },
  branch: { id: "branch", title: "إضافة فرع أو مستودع", endpoint: "/companies/me/branches", fields: [
    field("name", "اسم الفرع", "text", true), field("city", "المدينة", "text", true),
    field("address", "العنوان"), choiceField("isWarehouse", "نوع الموقع", [
      { value: "false", label: "فرع" }, { value: "true", label: "مستودع" },
    ]),
  ] },
  product: { id: "product", title: "إضافة منتج للكتالوج", endpoint: "/products", fields: [
    field("name", "اسم المنتج", "text", true), field("sku", "رمز المنتج"),
    field("description", "المواصفات", "textarea"), field("unit", "وحدة البيع", "text", true),
    field("minimumOrderQuantity", "أقل كمية للطلب", "number", true),
    choiceField("pricingMode", "طريقة التسعير", [
      { value: "quote", label: "سعر حسب الطلب / مواصفات المصنع" },
      { value: "public", label: "سعر معلن" },
    ]),
    field("unitPrice", "سعر الوحدة المعلن", "number", false, "مطلوب عند اختيار السعر المعلن."),
    field("currency", "العملة (رمز ISO)", "text", false, "مثل SAR."),
    field("priceTiers", "شرائح أسعار الكميات (JSON اختياري)", "json", false, '[{"minimumQuantity":10,"unitPrice":8.5}]'),
    field("productionCapacity", "الطاقة الإنتاجية (وحدة القياس أعلاه)", "number"),
    field("leadTimeDays", "مدة التجهيز بالأيام", "number"),
    field("deliveryRegions", "مناطق التوزيع (افصل بينها بفاصلة)", "text"),
    field("specifications", "المواصفات التفصيلية (JSON)", "json", false, '{"المادة":"مثال","بلد المنشأ":"مثال"}'),
  ] },
  service: { id: "service", title: "إضافة خدمة", endpoint: "/services", fields: [
    field("name", "اسم الخدمة", "text", true), choiceField("category", "التصنيف", [
      { value: "توفير العمالة", label: "توفير العمالة" }, { value: "التدريب والتأهيل", label: "التدريب والتأهيل" },
      { value: "التشغيل والإدارة", label: "التشغيل والإدارة" }, { value: "الصيانة", label: "الصيانة" },
      { value: "النظافة", label: "النظافة" }, { value: "التأسيس والتجهيز", label: "التأسيس والتجهيز" },
      { value: "التسويق والإعلانات", label: "التسويق والإعلانات" }, { value: "التصميم والهوية التجارية", label: "التصميم والهوية التجارية" },
      { value: "الاستشارات", label: "الاستشارات" }, { value: "المحاسبة والخدمات الإدارية", label: "المحاسبة والخدمات الإدارية" },
      { value: "التقنية والأنظمة", label: "التقنية والأنظمة" }, { value: "التجهيزات والمقاولات", label: "التجهيزات والمقاولات" },
    ]),
    field("description", "وصف الخدمة", "textarea"), field("coverage", "مدن التغطية (افصل بينها بفاصلة)", "text", true),
    field("priceFrom", "السعر الابتدائي", "number"),
  ] },
  serviceRequest: { id: "serviceRequest", title: "طلب خدمة", endpoint: "/service-requests", fields: [
    field("title", "عنوان الطلب", "text", true), field("description", "وصف الاحتياج", "textarea", true),
    field("city", "المدينة"), sourceField("providerCompanyId", "مقدم خدمة محدد (اختياري)", "/directory/companies?type=service_provider"),
    field("requestedAt", "الموعد المطلوب", "datetime"),
  ] },
  rfq: { id: "rfq", title: "إنشاء طلب عروض أسعار", endpoint: "/rfqs", itemRows: true, fields: [
    field("title", "عنوان الطلب", "text", true), field("notes", "المواصفات أو الشروط", "textarea"),
    field("responseDueAt", "آخر موعد لاستقبال العروض", "datetime"),
    sourceField("supplierCompanyIds", "الموردون المدعوون", "/directory/companies?type=supplier", true, true),
  ] },
  quote: { id: "quote", title: "تقديم عرض سعر", endpoint: "", fields: [
    field("totalAmount", "القيمة الإجمالية", "number", true), field("currency", "العملة (رمز ISO)"),
    field("validUntil", "العرض صالح حتى", "date"), field("notes", "ملاحظات", "textarea"),
  ] },
  warehouse: { id: "warehouse", title: "إضافة مستودع", endpoint: "/inventory/warehouses", fields: [
    field("name", "اسم المستودع", "text", true), field("city", "المدينة", "text", true),
    sourceField("branchId", "الفرع المرتبط (اختياري)", "/companies/me/branches"),
  ] },
  inventoryProduct: { id: "inventoryProduct", title: "إضافة صنف للمخزون", endpoint: "/inventory/products", fields: [
    field("name", "اسم الصنف", "text", true), field("barcode", "الباركود (اتركه فارغًا للتوليد)", "text"),
    field("unit", "وحدة القياس", "text", true), field("lowStockThreshold", "حد التنبيه عند الانخفاض", "number", true),
    sourceField("sourceProductId", "ربط بمنتج المورد (اختياري)", "/products"),
  ] },
  movement: { id: "movement", title: "تسجيل حركة مخزون", endpoint: "/inventory/movements", fields: [
    sourceField("warehouseId", "المستودع", "/inventory/warehouses", true),
    sourceField("inventoryProductId", "الصنف", "/inventory/products", true),
    choiceField("movementType", "نوع الحركة", [
      { value: "receipt", label: "استلام" }, { value: "issue", label: "صرف" }, { value: "adjustment", label: "تسوية جرد" },
    ]),
    field("quantity", "الكمية", "number", true),
    choiceField("isIncrease", "اتجاه التسوية", [
      { value: "true", label: "زيادة المخزون" }, { value: "false", label: "تخفيض المخزون" },
    ], false),
    field("batchNumber", "رقم الدفعة"), field("expiresOn", "تاريخ انتهاء الصلاحية", "date"),
    field("reference", "مرجع الطلب أو التحويل"), field("notes", "ملاحظات"),
  ] },
  transfer: { id: "transfer", title: "تحويل بين مستودعين", endpoint: "/inventory/transfers", fields: [
    sourceField("sourceWarehouseId", "المستودع المصدر", "/inventory/warehouses", true),
    sourceField("destinationWarehouseId", "المستودع المستلم", "/inventory/warehouses", true),
    sourceField("inventoryProductId", "الصنف", "/inventory/products", true),
    field("quantity", "الكمية", "number", true), field("batchNumber", "رقم الدفعة"),
    field("expiresOn", "تاريخ انتهاء الصلاحية", "date"), field("reference", "المرجع"), field("notes", "ملاحظات"),
  ] },
  count: { id: "count", title: "بدء جرد فعلي", endpoint: "/inventory/counts", fields: [
    sourceField("warehouseId", "المستودع", "/inventory/warehouses", true),
  ] },
  shipment: { id: "shipment", title: "إنشاء شحنة", endpoint: "/shipments", fields: [
    sourceField("orderId", "أمر الشراء (اختياري)", "/orders"),
    choiceField("temperatureRequirement", "درجة الحرارة", [
      { value: "ambient", label: "عادي" }, { value: "chilled", label: "مبرد" }, { value: "frozen", label: "مجمد" },
    ]),
    field("estimatedWeightKg", "الوزن التقديري بالكيلوغرام", "number"),
    field("pickupAddress", "عنوان الاستلام", "text", true), field("pickupCity", "مدينة الاستلام", "text", true),
    field("deliveryAddress", "عنوان التسليم", "text", true), field("deliveryCity", "مدينة التسليم", "text", true),
    field("scheduledAt", "موعد التسليم المطلوب", "datetime"),
  ] },
  carrierProfile: { id: "carrierProfile", title: "تحديث ملف شركة النقل", endpoint: "/logistics/profile", fields: [
    field("coverageCities", "مدن التغطية (افصل بينها بفاصلة)", "text", true, "اكتب أسماء المدن كما ستظهر في عنوان الشحنة."),
    field("transportTypes", "أنواع النقل: road,refrigerated,frozen,express", "text", true),
    field("temperatureCapabilities", "درجات الحرارة: ambient,chilled,frozen", "text", true, "اكتب قيمة واحدة أو أكثر مفصولة بفاصلة."),
    field("maxPayloadKg", "أقصى حمولة بالكيلوغرام", "number"),
  ] },
  vehicle: { id: "vehicle", title: "تسجيل مركبة", endpoint: "/logistics/vehicles", fields: [
    field("vehicleType", "نوع المركبة", "text", true), field("plateNumber", "رقم اللوحة", "text", true),
    field("maxPayloadKg", "الحمولة القصوى بالكيلوغرام", "number", true),
    field("temperatureCapabilities", "درجات الحرارة: ambient,chilled,frozen", "text", true, "اكتب قيمة واحدة أو أكثر مفصولة بفاصلة."),
  ] },
  contract: { id: "contract", title: "إنشاء مسودة عقد", endpoint: "/contracts", fields: [
    sourceField("counterpartyCompanyId", "المورد الطرف المقابل", "/directory/companies?type=supplier", true),
    field("title", "عنوان العقد", "text", true), field("terms", "بنود الاتفاق", "textarea", true),
    sourceField("orderId", "أمر شراء مرتبط (اختياري)", "/orders"),
    field("startsOn", "تاريخ البداية", "date"), field("endsOn", "تاريخ الانتهاء", "date"),
  ] },
  invoice: { id: "invoice", title: "إنشاء مسودة فاتورة", endpoint: "/invoices", fields: [
    sourceField("customerCompanyId", "العميل", "/directory/companies?type=customer", true),
    sourceField("orderId", "أمر الشراء المرتبط (اختياري)", "/orders"),
    field("subtotal", "المبلغ قبل الضريبة", "money", true), field("taxAmount", "مبلغ الضريبة", "money", true),
    field("dueOn", "تاريخ الاستحقاق", "date"),
  ] },
  subscription: { id: "subscription", title: "تفعيل فترة اشتراك", endpoint: "/subscriptions", fields: [
    choiceField("planCode", "الباقة", [
      { value: "customer_business", label: "إدارة أعمال العميل" }, { value: "inventory_basic", label: "مخزون أساسي" },
      { value: "inventory_business", label: "مخزون أعمال" }, { value: "inventory_enterprise", label: "مخزون مؤسسي" },
      { value: "procurement", label: "إدارة المشتريات" }, { value: "logistics", label: "إدارة الخدمات اللوجستية" },
      { value: "supplier_premium", label: "مزايا المورد" }, { value: "enterprise", label: "المؤسسات" },
    ]),
  ] },
  managedService: { id: "managedService", title: "طلب خدمة إدارة المخزون والتوريد", endpoint: "/managed-inventory/services", fields: [
    sourceField("warehouseId", "المستودع", "/inventory/warehouses", true),
    choiceField("autoReorder", "تفويض إعادة التوريد", [
      { value: "true", label: "السماح بالشراء الآلي ضمن السقوف أدناه" },
      { value: "false", label: "إنشاء طلب عروض تلقائيًا، مع اعتماد العميل قبل الشراء" },
    ]),
    field("perOrderBudget", "السقف الأعلى للطلب الواحد (ريال)", "money", true, "لا ينفذ شراء يتجاوز هذا المبلغ."),
    field("monthlyBudget", "السقف الأعلى لإجمالي التوريد خلال الشهر (ريال)", "money", true, "يجب أن يساوي سقف الطلب أو يزيد عليه."),
    field("requestNotes", "حجم العمل أو ملاحظات المستودع", "textarea"),
  ] },
  managedRule: { id: "managedRule", title: "تحديد صنف ومورد وسقوف إعادة التوريد", endpoint: "/managed-inventory/rules", fields: [
    sourceField("serviceId", "طلب الخدمة المرتبط", "/managed-inventory/service-options", true),
    sourceField("inventoryProductId", "صنف المخزون المرتبط بمنتج المورد", "/inventory/products", true),
    sourceField("supplierCompanyId", "المورد المحدد", "/directory/companies?type=supplier", true),
    field("reorderBelowQuantity", "ابدأ الطلب عندما يصل المخزون إلى (أو أقل من)", "number", true),
    field("reorderQuantity", "كمية إعادة التوريد الثابتة", "number", true),
    field("maxUnitPrice", "أعلى سعر مسموح للوحدة (ريال)", "money", true),
  ] },
  claim: { id: "claim", title: "فتح شكوى على أمر شراء", endpoint: "/claims", fields: [
    sourceField("orderId", "أمر الشراء", "/orders", true),
    field("respondentCompanyId", "رقم الشركة المقابلة (اختياري)", "text"),
    field("title", "عنوان المطالبة", "text", true), field("description", "شرح الواقعة", "textarea", true),
  ] },
  integration: { id: "integration", title: "تسجيل إعداد تكامل", endpoint: "/integrations", fields: [
    choiceField("integrationType", "نوع النظام", [
      { value: "erp", label: "ERP" }, { value: "pos", label: "نقطة بيع" },
      { value: "accounting", label: "محاسبة" }, { value: "shipping", label: "شحن" },
      { value: "barcode", label: "باركود" }, { value: "other", label: "أخرى" },
    ]),
    field("name", "اسم التكامل", "text", true), field("endpointUrl", "عنوان HTTPS (اختياري)", "url"),
    field("configuration", "إعدادات غير سرية بصيغة JSON", "json", false, "يحظر إدخال كلمات مرور أو مفاتيح أو بيانات دخول في هذا الحقل."),
  ] },
};

type AuthMode = "login" | "register";

function normalizedRows(payload: unknown, responseKey?: string): DataRow[] {
  if (Array.isArray(payload)) return payload as DataRow[];
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (responseKey && Array.isArray(record[responseKey])) {
    return (record[responseKey] as DataRow[]).map((row) => ({ ...row, _group: responseKey }));
  }
  if (responseKey === "inventoryAlerts") {
    return ["lowStock", "expiring"].flatMap((key) =>
      Array.isArray(record[key]) ? (record[key] as DataRow[]).map((row) => ({ ...row, _group: key })) : [],
    );
  }
  if (responseKey === "controlTower") {
    const groups: Record<string, string> = {
      openRfqs: "طلبات عروض مفتوحة",
      activeShipments: "شحنات نشطة",
      openClaims: "مطالبات مفتوحة",
    };
    return Object.entries(groups).flatMap(([key]) =>
      Array.isArray(record[key])
        ? (record[key] as DataRow[]).map((row) => ({
          id: row.id,
          _group: key,
          reference: row.reference,
          title: row.title ?? row.requestTitle ?? row.reference,
          status: row.status,
          createdAt: row.createdAt ?? row.scheduledAt,
        }))
        : [],
    );
  }
  if (Array.isArray(record.data)) return record.data as DataRow[];
  return [record];
}

function labelFor(key: string): string {
  const labels: Record<string, string> = {
    id: "المعرف", reference: "الرقم", displayName: "الاسم التجاري", legalName: "الاسم القانوني",
    requestTitle: "طلب التوريد", confirmedAt: "تاريخ التأكيد",
    type: "النوع", status: "الحالة", registrationNumber: "السجل التجاري", taxNumber: "الرقم الضريبي",
    contactEmail: "البريد", contactPhone: "الهاتف", createdAt: "تاريخ الإنشاء", joinedAt: "تاريخ الانضمام",
    name: "الاسم", city: "المدينة", address: "العنوان", isWarehouse: "مستودع", email: "البريد",
    role: "الصلاحية", sku: "رمز المنتج", unit: "الوحدة", minimumOrderQuantity: "أقل طلب",
    isActive: "فعال", category: "التصنيف", coverage: "التغطية", priceFrom: "يبدأ من",
    providerName: "مقدم الخدمة", customerName: "العميل", providerCompanyId: "مقدم الخدمة",
    title: "الموضوع", quoteCount: "عدد العروض", quoteStatus: "حالة العرض", myQuoteStatus: "حالة عرضك",
    myQuoteAmount: "قيمة عرضك", currency: "العملة", totalAmount: "الإجمالي", subtotal: "قبل الضريبة",
    taxAmount: "الضريبة", paidAmount: "المدفوع المسجل", dueOn: "الاستحقاق", startsOn: "بداية العقد",
    endsOn: "نهاية العقد", signatureCount: "التوقيعات", claimantName: "مقدم المطالبة",
    respondentName: "الطرف المقابل", resolvedAt: "تاريخ المعالجة", warehouseName: "المستودع",
    warehouseCity: "مدينة المستودع", autoReorder: "شراء آلي مفوض",
    perOrderBudget: "سقف الطلب الواحد (ريال)", monthlyBudget: "سقف الشهر (ريال)",
    monthlyFee: "الرسوم الشهرية (ريال)", quoteNotes: "تفاصيل العرض", requestNotes: "ملاحظات الطلب",
    ruleCount: "الأصناف المحددة", serviceStatus: "حالة الخدمة", serviceId: "طلب الخدمة",
    supplierName: "المورد المحدد", supplierCompanyId: "المورد المحدد",
    reorderBelowQuantity: "حد بدء إعادة التوريد", reorderQuantity: "كمية إعادة التوريد",
    maxUnitPrice: "أقصى سعر للوحدة (ريال)", currentQuantity: "المخزون عند التنبيه",
    requestedQuantity: "كمية الطلب", authorizedAmount: "قيمة الشراء المفوضة",
    blockReason: "سبب طلب المراجعة", rfqReference: "طلب عروض السعر", orderReference: "أمر الشراء",
    scopeSummary: "الأصناف والكميات المطلوبة",
    warehouseId: "معرف المستودع", barcode: "الباركود", lowStockThreshold: "حد التنبيه",
    productName: "الصنف", productId: "الصنف", batchNumber: "الدفعة", expiresOn: "الصلاحية",
    sourceSupplierName: "المورد المرتبط",
    quantity: "الكمية", movementType: "نوع الحركة", createdBy: "سجلها",
    itemCount: "عدد الأصناف", discrepancyCount: "الفروقات", completedAt: "تاريخ الإكمال",
    pickupCity: "من مدينة", deliveryCity: "إلى مدينة", pickupAddress: "عنوان الاستلام",
    deliveryAddress: "عنوان التسليم", temperatureRequirement: "الحرارة", scheduledAt: "الموعد",
    deliveredAt: "وقت التسليم", carrierName: "الناقل", carrierCompanyId: "شركة النقل",
    coverageCities: "مدن التغطية", updatedAt: "آخر تحديث",
    carrierVehicleId: "المركبة", driverUserId: "السائق", vehicleType: "نوع المركبة",
    plateNumber: "اللوحة", maxPayloadKg: "الحمولة كجم", transportTypes: "أنواع النقل",
    temperatureCapabilities: "قدرات الحرارة", planCode: "الباقة", priceMonthly: "الرسوم الشهرية",
    startsAt: "يبدأ في", endsAt: "ينتهي في", integrationType: "نوع التكامل", endpointUrl: "نقطة الاتصال",
    configuration: "الإعدادات", actorName: "المستخدم", eventType: "الحدث", entityType: "نوع السجل",
    entityId: "معرف السجل", details: "التفاصيل", _group: "نوع العنصر", _value: "القيمة",
    responseDueAt: "آخر موعد", notes: "ملاحظات", description: "الوصف", _actions: "إجراءات",
  };
  return labels[key] ?? key;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "نعم" : "لا";
  if (Array.isArray(value)) return value.join("، ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function App() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return <MarketingLanding />;
  if (path === "/supply" || path === "/services") {
    return <MarketplacePortal kind={path === "/supply" ? "supply" : "services"} />;
  }
  return <CompanyApplication />;
}

function CompanyApplication() {
  const [session, setSession] = useState<UserSession | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [sessionError, setSessionError] = useState("");
  const ownerPortal = window.location.pathname === "/owner";

  const refreshSession = useCallback(async () => {
    try {
      await apiRequest("/auth/csrf");
      const current = await apiRequest<UserSession>("/auth/me");
      setSession(current);
      setSessionError("");
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === 401) {
        setSession(null);
        setSessionError("");
      } else {
        setSessionError(error instanceof Error ? error.message : "تعذر الاتصال بالخادم.");
      }
    } finally {
      setLoadingSession(false);
    }
  }, []);

  useEffect(() => { void refreshSession(); }, [refreshSession]);

  if (loadingSession) return <div className="full-screen-state"><span className="spinner" /><p>التحقق من الجلسة والاتصال بالخادم...</p></div>;
  if (!session) return <AuthenticationPage onAuthenticated={refreshSession} serverError={sessionError} ownerPortal={ownerPortal} />;
  if (ownerPortal && (session.activeCompany.type !== "operator" || session.activeCompany.role !== "owner")) {
    return <OwnerPortalAccess session={session} />;
  }
  return <Workspace session={session} onSessionChange={refreshSession} />;
}

function OwnerPortalAccess({ session }: { session: UserSession }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ownerMembership = session.memberships.find((membership) => membership.type === "operator" && membership.role === "owner");

  async function switchToOwnerWorkspace() {
    if (!ownerMembership || busy) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest("/auth/switch-company", { method: "POST", body: { companyId: ownerMembership.company_id } });
      window.location.assign("/owner");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذر فتح مساحة مالك المنصة.");
      setBusy(false);
    }
  }

  return <main className="full-screen-state owner-access-page">
    <section className="owner-access-card" aria-labelledby="owner-access-title">
      <span className="brand-mark">م</span>
      <p className="eyebrow">مساحة خاصة</p>
      <h1 id="owner-access-title">إدارة مالك المنصة</h1>
      <p>{ownerMembership
        ? "هذه الجلسة على مساحة أخرى. بدّل إلى مساحة إدارة المنظومة للمتابعة."
        : "هذه الصفحة لا تفتح إلا بحساب مالك المنصة. تسجيل الشركات العام لا يمنح صلاحية الإدارة."}</p>
      {error && <div className="form-error" role="alert">{error}</div>}
      {ownerMembership
        ? <button className="primary-button owner-access-button" type="button" disabled={busy} onClick={() => void switchToOwnerWorkspace()}>
          {busy ? "جارٍ فتح مساحة المالك..." : "فتح مساحة مالك المنصة"}
        </button>
        : <a className="primary-button owner-access-button" href="/companies">العودة إلى بوابة الشركات</a>}
      <a className="owner-access-home" href="/">العودة إلى الصفحة الرئيسية</a>
    </section>
  </main>;
}

function MarketingLanding() {
  useEffect(() => { document.title = "مركز الأعمال | بوابات أعمال B2B"; }, []);
  const platforms = [
    { number: "01", title: "بوابة الشركات", description: "مساحة خاصة للمشتريات والفروع والطلبات والعقود والمخزون والفواتير.", href: "/companies", action: "دخول مساحة الشركات", icon: "ش" },
    { number: "02", title: "سوق المصانع والموردين", description: "كتالوج توريد عام للمنتجات المعتمدة، مع حد الطلب ومورد كل منتج.", href: "/supply", action: "تصفح سوق التوريد", icon: "ت" },
    { number: "03", title: "دليل الخدمات", description: "اكتشف خدمات الأعمال ومقدميها واطلب الخدمة من صفحة مستقلة.", href: "/services", action: "اكتشف الخدمات", icon: "خ" },
    { number: "04", title: "بوابة اللوجستيات", description: "مساحة تشغيل لشركات النقل ضمن حساب الشريك لإدارة الشحنات والتسليم.", href: "/companies?type=logistics_provider", action: "تسجيل شركة نقل", icon: "ل" },
    { number: "05", title: "المخزون والباركود", description: "أدوات تشغيلية اختيارية للمستودعات والحركات والجرد ضمن مساحة الشركة.", href: "/companies", action: "إدارة المخزون", icon: "م" },
    { number: "06", title: "العقود والصفقات", description: "طلبات عروض الأسعار والعروض وأوامر الشراء والعقود والمطالبات.", href: "/companies", action: "إدارة الصفقات", icon: "ع" },
    { number: "07", title: "لوحة مالك المنصة", description: "مساحة خاصة للمشغل لاعتماد الشركات ومراجعة العمليات وتسعير الخدمات.", href: "/owner", action: "دخول المالك الخاص", icon: "إ" },
    { number: "08", title: "التشغيل الميداني", description: "واجهات متجاوبة لأعمال المستودع والنقل ومتابعة الطلبات.", href: "/companies", action: "استكشف مساحة العمل", icon: "↗" },
    { number: "09", title: "إدارة المخزون والتوريد", description: "اطلب متابعة مخزون مستودعك، وحدد الموردين وسقوف إعادة التوريد الآلية.", href: "/companies?section=finance", action: "اطلب الخدمة التشغيلية", icon: "↻" },
  ];

  return <div className="portal-page landing-page" dir="rtl">
    <header className="portal-header">
      <a className="portal-brand" href="/"><span className="brand-mark">م</span><span><strong>مركز الأعمال</strong><small>منظومة أعمال مترابطة</small></span></a>
      <nav className="portal-navigation" aria-label="التنقل بين المنصات">
        <a href="/companies">الشركات</a><a href="/supply">التوريد</a><a href="/services">الخدمات</a>
      </nav>
      <a className="primary-button" href="/companies">دخول الشركات <span aria-hidden="true">←</span></a>
    </header>
    <main>
      <section className="landing-hero">
        <div className="landing-hero-copy">
          <span className="portal-eyebrow"><i /> منظومة أعمال B2B</span>
          <h1>كل شريك له بوابته.<br /><em>وكل عملية تبقى متصلة.</em></h1>
          <p>منصة مركزية تربط الشركات بالمصانع ومقدمي الخدمات وشركات النقل، مع مساحات منفصلة لكل دور ودورة عمل قابلة للمتابعة.</p>
          <div className="landing-actions"><a className="primary-button" href="/companies">ابدأ من بوابة الشركات <span aria-hidden="true">←</span></a><a className="secondary-button" href="/supply">تصفح التوريد</a></div>
          <div className="landing-assurance"><span>◈</span> كتالوجات وطلبات مرتبطة بالبيانات المسجلة في المنظومة</div>
        </div>
        <div className="landing-visual" aria-label="مسارات مترابطة بين الشركات والموردين والخدمات">
          <div className="visual-orbit orbit-one" /><div className="visual-orbit orbit-two" />
          <div className="visual-core"><span>م</span><strong>مركز الأعمال</strong><small>مسارات تجارية متصلة</small></div>
          <div className="visual-node node-company"><span>ش</span><small>الشركات</small></div>
          <div className="visual-node node-supply"><span>ت</span><small>التوريد</small></div>
          <div className="visual-node node-service"><span>خ</span><small>الخدمات</small></div>
          <div className="visual-node node-logistics"><span>ل</span><small>اللوجستيات</small></div>
          <div className="visual-caption">طلب · عرض · تنفيذ · تسليم</div>
        </div>
      </section>
      <section className="landing-proof" aria-label="إحصاءات المنظومة">
        <div><strong>+٦٠٠</strong><span>شريك تجاري مستهدف</span></div>
        <div><strong>٢٤/٧</strong><span>متابعة الطلبات والعمليات</span></div>
        <div><strong>٩</strong><span>مجالات تشغيل متصلة</span></div>
        <div><strong>١</strong><span>منظومة موحدة للشركات</span></div>
      </section>
      <section className="landing-trust-strip" aria-label="أقسام المنظومة">
        <span>قطاع الصناعات الغذائية</span><i>•</i><span>المستهلكات الطبية</span><i>•</i><span>المواد الخام</span><i>•</i><span>الخدمات المهنية</span><i>•</i><span>النقل واللوجستيات</span>
      </section>
      <section className="portal-section platform-section" id="platforms">
        <div className="section-intro"><div><span className="portal-eyebrow">تسعة مجالات عمل</span><h2>بوابات مستقلة، منظومة واحدة</h2></div><p>ابدأ من التجربة المناسبة لك؛ الدخول والصلاحيات والبيانات التشغيلية تظل محكومة بمساحة شركتك.</p></div>
        <div className="platform-grid">{platforms.map((platform) => <a className="platform-card" href={platform.href} key={platform.number}>
          <div className="platform-card-top"><span className="platform-icon">{platform.icon}</span><span className="platform-number">{platform.number}</span></div>
          <h3>{platform.title}</h3><p>{platform.description}</p><span className="platform-action">{platform.action}<span aria-hidden="true"> ←</span></span>
        </a>)}</div>
      </section>
      <section className="landing-workflow">
        <div><span className="portal-eyebrow">من الطلب حتى الإغلاق</span><h2>العملية كاملة، لا مجرد عرض منتجات</h2><p>يبدأ العميل بطلب موحد، ثم تصل طلبات التوريد إلى الموردين المحددين، وتُدار العروض والشراء والشحن والتسليم من مساحة الشركة.</p></div>
        <ol className="workflow-steps"><li><span>01</span><strong>استكشاف</strong><small>كتالوج أو خدمة</small></li><li><span>02</span><strong>طلب وعرض</strong><small>مورد أو مقدم خدمة</small></li><li><span>03</span><strong>تنفيذ ونقل</strong><small>أمر وشحنة</small></li><li><span>04</span><strong>استلام وإغلاق</strong><small>متابعة داخل مساحة الشركة</small></li></ol>
      </section>
      <section className="landing-bottom-cta"><div><span className="portal-eyebrow">ابدأ في المساحة المناسبة</span><h2>أنت تحدد دور شركتك؛ والمنصة ترتب سير العمل.</h2></div><div className="landing-actions"><a className="primary-button" href="/companies?type=customer">تسجيل شركة مشترية</a><a className="secondary-button" href="/companies?type=supplier">تسجيل مورد أو مصنع</a></div></section>
    </main>
    <footer className="portal-footer"><a className="portal-brand" href="/"><span className="brand-mark">م</span><span><strong>مركز الأعمال</strong><small>Central Business Hub</small></span></a><nav aria-label="روابط المنصات"><a href="/companies">بوابة الشركات</a><a href="/supply">سوق التوريد</a><a href="/services">دليل الخدمات</a></nav><span>منظومة B2B متعددة البوابات</span></footer>
  </div>;
}

function MarketplacePortal({ kind }: { kind: "supply" | "services" }) {
  const isSupply = kind === "supply";
  const [products, setProducts] = useState<PublicProduct[]>([]);
  const [services, setServices] = useState<PublicService[]>([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [city, setCity] = useState("");
  const [deliveryRegion, setDeliveryRegion] = useState("");
  const [pricingFilter, setPricingFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [session, setSession] = useState<UserSession | null>(null);
  const [basket, setBasket] = useState<BasketItem[]>([]);
  const [basketOpen, setBasketOpen] = useState(false);
  const [selectedService, setSelectedService] = useState<PublicService | null>(null);
  const [formDescription, setFormDescription] = useState("");
  const [formCity, setFormCity] = useState("");
  const [rfqTitle, setRfqTitle] = useState("");
  const [rfqNotes, setRfqNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setCatalogError("");
      const endpoint = isSupply ? "/public/products" : "/public/services";
      const query = new URLSearchParams({ q: search });
      if (isSupply && deliveryRegion) query.set("region", deliveryRegion);
      if (isSupply && pricingFilter) query.set("pricing", pricingFilter);
      void apiRequest<{ data: PublicProduct[] | PublicService[] }>(
        `${endpoint}?${query}`,
        { signal: controller.signal },
      ).then((payload) => {
        if (!active) return;
        if (isSupply) setProducts(payload.data as PublicProduct[]);
        else setServices(payload.data as PublicService[]);
      }).catch((cause: unknown) => {
        if (!active || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setCatalogError(cause instanceof Error ? cause.message : "تعذر تحميل الدليل.");
      }).finally(() => { if (active) setLoading(false); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
  }, [deliveryRegion, isSupply, pricingFilter, search]);

  useEffect(() => {
    let active = true;
    void apiRequest<UserSession>("/auth/me").then((value) => { if (active) setSession(value); }).catch(() => {
      if (active) setSession(null);
    });
    return () => { active = false; };
  }, []);

  const customerSession = session?.activeCompany.type === "customer";
  const categories = [...new Set(services.map((service) => service.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ar"));
  const visibleServices = services.filter((service) => (!category || service.category === category)
    && (!city || coverageValues(service.coverage).some((value) => value.includes(city.trim()))));
  const loginUrl = session
    ? "/companies"
    : `/companies?type=customer&returnTo=${encodeURIComponent(isSupply ? "/supply" : "/services")}`;

  useEffect(() => {
    document.title = isSupply ? "سوق التوريد | مركز الأعمال" : "دليل الخدمات | مركز الأعمال";
  }, [isSupply]);

  function addToBasket(product: PublicProduct) {
    setBasket((current) => current.some((item) => item.product.id === product.id)
      ? current
      : [...current, { product, quantity: Number(product.minimumOrderQuantity) }]);
    setError("");
    setSuccess("");
  }

  function updateQuantity(productId: string, value: string) {
    setBasket((current) => current.map((item) => item.product.id === productId
      ? { ...item, quantity: value === "" ? 0 : Number(value) }
      : item));
  }

  async function submitRfq(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const invalidItem = basket.find((item) => !Number.isFinite(item.quantity)
      || item.quantity < Number(item.product.minimumOrderQuantity));
    if (invalidItem) {
      setError(`الكمية المطلوبة من «${invalidItem.product.name}» يجب ألا تقل عن ${invalidItem.product.minimumOrderQuantity} ${invalidItem.product.unit}.`);
      return;
    }
    setBusy(true);
    try {
      const supplierCompanyIds = [...new Set(basket.map((item) => item.product.supplierCompanyId))];
      await apiRequest("/rfqs", {
        method: "POST",
        body: {
          title: rfqTitle.trim(),
          ...(rfqNotes.trim() ? { notes: rfqNotes.trim() } : {}),
          supplierCompanyIds,
          items: basket.map(({ product, quantity }) => ({
            productId: product.id,
            description: product.name,
            quantity,
            unit: product.unit,
          })),
        },
      });
      setBasket([]);
      setBasketOpen(false);
      setSuccess("تم إرسال طلب عروض الأسعار إلى موردي المنتجات المحددين. تابع الردود من مساحة الشركة.");
      setRfqTitle("");
      setRfqNotes("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذر إرسال طلب التوريد.");
    } finally {
      setBusy(false);
    }
  }

  async function submitServiceRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedService) return;
    setError("");
    setBusy(true);
    try {
      await apiRequest("/service-requests", {
        method: "POST",
        body: {
          title: selectedService.name,
          ...(formDescription.trim() ? { description: formDescription.trim() } : {}),
          ...(formCity.trim() ? { city: formCity.trim() } : {}),
          listingId: selectedService.id,
          providerCompanyId: selectedService.providerCompanyId,
        },
      });
      setSelectedService(null);
      setFormDescription("");
      setFormCity("");
      setSuccess("تم إرسال طلب الخدمة إلى مقدمها. تابع حالته من مساحة الشركة.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذر إرسال طلب الخدمة.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="portal-page market-page" dir="rtl">
    <header className="portal-header">
      <a className="portal-brand" href="/"><span className="brand-mark">م</span><span><strong>مركز الأعمال</strong><small>{isSupply ? "سوق التوريد" : "دليل خدمات الأعمال"}</small></span></a>
      <nav className="portal-navigation" aria-label="التنقل بين المنصات"><a href="/companies">الشركات</a><a className={isSupply ? "active" : ""} href="/supply">التوريد</a><a className={!isSupply ? "active" : ""} href="/services">الخدمات</a></nav>
      <div className="market-header-actions">
        {isSupply && <button className="secondary-button market-basket-button" onClick={() => setBasketOpen((open) => !open)}>قائمة الطلب <span className="basket-count">{basket.length}</span></button>}
        <a className="primary-button" href={customerSession ? "/companies" : loginUrl}>{session ? "مساحة شركتي" : "دخول الشركات"}</a>
      </div>
    </header>
    <main>
      <section className={`market-hero ${isSupply ? "supply-hero" : "services-hero"}`}>
        <div className="market-hero-copy">
          <span className="portal-eyebrow"><i /> {isSupply ? "بوابة المصانع والموردين" : "بوابة الخدمات ومقدميها"}</span>
          <h1>{isSupply ? <>احتياجات شركتك،<br /><em>من موردها إلى طلب واحد.</em></> : <>خدمات أعمال مناسبة،<br /><em>من مقدميها مباشرة.</em></>}</h1>
          <p>{isSupply ? "اكتشف المنتجات المنشورة من الموردين المعتمدين، راجع وحدات البيع والحد الأدنى، ثم أرسل طلب عرض السعر من مساحة شركتك." : "تصفح خدمات الأعمال المتاحة ومجالات تغطيتها، ثم أرسل طلبك إلى مقدم الخدمة من مساحة شركتك."}</p>
          <a className="market-hero-link" href={customerSession ? "/companies" : loginUrl}>{customerSession ? "متابعة مساحة شركتك" : session ? "انتقل إلى مساحة الشركة لتبديل الحساب" : "سجّل الدخول للطلب"} <span aria-hidden="true">←</span></a>
        </div>
        <div className="market-hero-card"><span className="market-hero-card-label">{isSupply ? "طلب توريد موحد" : "طلب خدمة مرتبط بمقدمها"}</span><div className="market-flow"><span>{isSupply ? "منتجات" : "خدمات"}</span><i>←</i><span>طلب</span><i>←</i><span>تنفيذ</span></div><small>{isSupply ? "تُحفظ عروض الموردين بشكل منفصل لكل شركة." : "يرتبط الطلب بالخدمة ومقدمها المحددين."}</small></div>
      </section>
      <section className="market-content">
        <div className="market-title-row"><div><span className="portal-eyebrow">{isSupply ? "كتالوج المنتجات" : "كتالوج مقدمي الخدمات"}</span><h2>{isSupply ? "اكتشف ما تحتاجه شركتك" : "ابحث عن خدمة الأعمال المناسبة"}</h2><p>{isSupply ? "البيانات المعروضة منشورة من كتالوج الموردين النشطين." : "البيانات المعروضة منشورة من كتالوج مقدمي الخدمات النشطين."}</p></div>
          <span className="live-tag"><i /> {isSupply ? products.length : visibleServices.length} نتيجة</span></div>
        {isSupply && products.some((product) => product.isDemo) && <div className="demo-catalog-notice" role="note">
          <strong>كتالوج توضيحي للعرض</strong>
          <span>المنتجات والأسعار والموردون تجريبيون، والصور للتوضيح فقط وليست صور منتجات فعلية.</span>
        </div>}
        <div className="market-filters">
          <label className="market-search"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={isSupply ? "ابحث باسم المنتج أو المورد أو الرمز..." : "ابحث باسم الخدمة أو التصنيف أو مقدمها..."} aria-label="البحث في الدليل" /></label>
          {!isSupply && <><label className="market-filter"><span>التصنيف</span><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">كل التصنيفات</option>{categories.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label className="market-filter"><span>مدينة التغطية</span><input value={city} onChange={(event) => setCity(event.target.value)} placeholder="مثال: الرياض" /></label></>}
          {isSupply && <><label className="market-filter"><span>منطقة التوزيع</span><input value={deliveryRegion} onChange={(event) => setDeliveryRegion(event.target.value)} placeholder="اختياري" /></label><label className="market-filter"><span>التسعير</span><select value={pricingFilter} onChange={(event) => setPricingFilter(event.target.value)}><option value="">كل المنتجات</option><option value="public">سعر معلن</option><option value="quote">سعر حسب الطلب</option></select></label></>}
        </div>
        {success && <div className="notice success market-notice" role="status">{success}<a href="/companies">الانتقال إلى مساحة الشركة ←</a></div>}
        {error && !selectedService && !basketOpen && <div className="notice warning market-notice" role="alert">{error}</div>}
        {catalogError && <div className="notice warning market-notice" role="alert">{catalogError}</div>}
        {loading ? <div className="market-loading"><span className="spinner" /> جارٍ تحميل البيانات المنشورة...</div> : isSupply
          ? <div className="market-product-grid">{products.map((product) => <article className="market-product-card" key={product.id}>
            <div className="product-card-visual"><span>{product.name.slice(0, 1)}</span>{product.imageUrl && <img src={product.imageUrl} alt={`صورة توضيحية: ${product.name}`} loading="lazy" referrerPolicy="no-referrer" onError={(event) => event.currentTarget.remove()} />}{product.isDemo && <strong className="demo-product-badge">بيانات تجريبية</strong>}<small>{product.sku || "منتج مورد"}</small></div>
            <div className="product-card-body"><div className="product-vendor"><span className={product.isDemo ? "demo-company-mark" : "verified-mark"}>{product.isDemo ? "ت" : "✓"}</span>{product.supplierName}</div><h3>{product.name}</h3><p>{product.description || "تواصل مع المورد لمعرفة المواصفات والتوفر."}</p>
              <div className="product-meta"><div><small>{product.pricingMode === "public" ? "سعر الوحدة" : "التسعير"}</small><strong>{product.pricingMode === "public" && product.unitPrice !== null
                ? `${new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 2 }).format(Number(product.unitPrice))} ${product.currency}`
                : "حسب عرض المورد"}</strong></div><div><small>الحد الأدنى</small><strong>{product.minimumOrderQuantity} <span>{product.unit}</span></strong></div></div>
              {product.priceTiers.length > 0 && <div className="product-tier-list"><strong>أسعار الكميات</strong>{product.priceTiers.map((tier) => <span key={String(tier.minimumQuantity)}>{tier.minimumQuantity}+ {product.unit}: {new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 2 }).format(Number(tier.unitPrice))} {product.currency}</span>)}</div>}
              <div className="product-fulfilment">{product.leadTimeDays !== null && <span>التجهيز: {product.leadTimeDays} يوم</span>}{product.productionCapacity !== null && <span>الطاقة: {product.productionCapacity} {product.unit}</span>}{product.deliveryRegions.length > 0 && <span>التوزيع: {product.deliveryRegions.join("، ")}</span>}</div>
              {Object.keys(product.specifications).length > 0 && <details className="product-specifications"><summary>المواصفات</summary><dl>{Object.entries(product.specifications).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></details>}
              {customerSession ? <button className={`primary-button product-add-button ${basket.some((item) => item.product.id === product.id) ? "added" : ""}`} onClick={() => addToBasket(product)}>{basket.some((item) => item.product.id === product.id) ? "أضيف إلى قائمة الطلب ✓" : "أضف إلى طلب عرض السعر"}</button>
                : <a className="primary-button product-add-button" href={loginUrl}>{session ? "انتقل إلى حساب مشترٍ" : "اطلب عبر مساحة الشركة"}</a>}
            </div>
          </article>)}</div>
          : <div className="service-card-grid">{visibleServices.map((service) => <article className="service-card" key={service.id}>
            <div className="service-card-top"><span className="service-category-icon">{service.category.slice(0, 1)}</span><span className="service-category">{service.category}</span></div><h3>{service.name}</h3><p>{service.description || "تواصل مع مقدم الخدمة لمناقشة نطاق العمل والتفاصيل."}</p>
            <div className="service-provider"><span className="verified-mark">✓</span><strong>{service.providerName}</strong></div>
            <div className="service-coverage"><span>◉</span><div><small>مدن التغطية</small><strong>{coverageValues(service.coverage).join("، ") || "يحددها مقدم الخدمة عند الطلب"}</strong></div></div>
            <div className="service-price">{service.priceFrom === null ? <strong>اطلب عرض سعر</strong> : <><small>يبدأ من</small><strong>{new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 2 }).format(Number(service.priceFrom))} {service.currency}</strong></>}</div>
            <button className="primary-button service-request-button" onClick={() => { setSelectedService(service); setFormCity(city); setError(""); }}>{customerSession ? "طلب هذه الخدمة" : session ? "انتقل إلى مساحة الشركة" : "سجّل الدخول لطلب الخدمة"}</button>
          </article>)}</div>}
        {!loading && !catalogError && (isSupply ? products.length === 0 : visibleServices.length === 0) && <div className="market-empty"><span>⌕</span><h3>لا توجد نتائج مطابقة</h3><p>جرّب تغيير عبارة البحث أو المرشحات، أو عد لاحقًا عند نشر عروض جديدة.</p></div>}
      </section>
      <section className="market-crosslink"><div><span className="portal-eyebrow">كل البوابات متصلة</span><h2>{isSupply ? "هل تبحث عن خدمة متخصصة؟" : "هل تحتاج إلى منتجات للتوريد؟"}</h2><p>استخدم الدليل المنفصل المناسب واحتفظ بمتابعة الطلبات داخل مساحة شركتك.</p></div><a className="secondary-button" href={isSupply ? "/services" : "/supply"}>{isSupply ? "الانتقال إلى دليل الخدمات" : "الانتقال إلى سوق التوريد"} <span aria-hidden="true">←</span></a></section>
    </main>
    <footer className="portal-footer"><a className="portal-brand" href="/"><span className="brand-mark">م</span><span><strong>مركز الأعمال</strong><small>مسارات أعمال مترابطة</small></span></a><nav aria-label="روابط المنصات"><a href="/companies">بوابة الشركات</a><a href="/supply">سوق التوريد</a><a href="/services">دليل الخدمات</a></nav><span>الأسعار تخضع لعروض الموردين ومقدمي الخدمات</span></footer>
    {isSupply && basketOpen && <div className="portal-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setBasketOpen(false); }}>
      <section className="portal-modal" role="dialog" aria-modal="true" aria-labelledby="basket-title">
        <button className="portal-modal-close" onClick={() => setBasketOpen(false)} aria-label="إغلاق">×</button><span className="portal-eyebrow">طلب واحد، موردون محددون</span><h2 id="basket-title">قائمة طلب عروض الأسعار</h2>
        {!customerSession && <div className="notice warning">{session ? "إنشاء الطلب متاح لحساب الشركة المشترية. انتقل إلى مساحة شركتك لتبديل الحساب." : "لإنشاء الطلب، سجّل الدخول بحساب شركة مشترية. ستعود إلى سوق التوريد بعد الدخول."}</div>}
        {!basket.length ? <div className="market-empty compact"><p>أضف منتجات من الكتالوج لتجميعها في طلب عروض أسعار.</p></div> : <form onSubmit={(event) => void submitRfq(event)}>
          <div className="basket-items">{basket.map(({ product, quantity }) => <div className="basket-item" key={product.id}>
            <div><strong>{product.name}</strong><small>{product.supplierName} · الحد الأدنى {product.minimumOrderQuantity} {product.unit}</small></div>
            <label><span>الكمية</span><input type="number" step="any" min={Number(product.minimumOrderQuantity)} value={quantity || ""} onChange={(event) => updateQuantity(product.id, event.target.value)} required /></label>
            <button type="button" className="basket-remove" onClick={() => setBasket((current) => current.filter((item) => item.product.id !== product.id))} aria-label={`حذف ${product.name}`}>×</button>
          </div>)}</div>
          <label className="form-field">عنوان طلب التوريد<input value={rfqTitle} onChange={(event) => setRfqTitle(event.target.value)} required minLength={3} maxLength={200} placeholder="مثال: توريد مواد تشغيل شهرية" /></label>
          <label className="form-field">مواصفات أو ملاحظات إضافية<textarea value={rfqNotes} onChange={(event) => setRfqNotes(event.target.value)} maxLength={4000} rows={3} /></label>
          {error && <div className="form-error" role="alert">{error}</div>}
          <button type="submit" className="primary-button auth-submit" disabled={busy || !customerSession}>{busy ? "جارٍ إرسال الطلب..." : "إرسال طلب عروض الأسعار"}</button>
          {!customerSession && <a className="secondary-button market-login-link" href={loginUrl}>{session ? "الانتقال إلى مساحة الشركة" : "الدخول أو إنشاء حساب مشترٍ"}</a>}
        </form>}
        {!basket.length && <button className="secondary-button market-login-link" onClick={() => setBasketOpen(false)}>العودة إلى المنتجات</button>}
      </section>
    </div>}
    {selectedService && <div className="portal-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedService(null); }}>
      <section className="portal-modal" role="dialog" aria-modal="true" aria-labelledby="service-request-title">
        <button className="portal-modal-close" onClick={() => setSelectedService(null)} aria-label="إغلاق">×</button><span className="portal-eyebrow">طلب مرتبط بالخدمة</span><h2 id="service-request-title">طلب {selectedService.name}</h2><p className="modal-provider-name">{selectedService.providerName} · {selectedService.category}</p>
        {!customerSession ? <><div className="notice warning">{session ? "يلزم اختيار مساحة شركة مشترية لإرسال طلب الخدمة." : "يلزم حساب شركة مشترية لإرسال طلب الخدمة."}</div><a className="primary-button auth-submit" href={loginUrl}>{session ? "الانتقال إلى مساحة الشركة" : "الدخول أو إنشاء حساب مشترٍ"}</a></> : <form onSubmit={(event) => void submitServiceRequest(event)}>
          <label className="form-field">وصف الاحتياج<textarea value={formDescription} onChange={(event) => setFormDescription(event.target.value)} maxLength={3000} rows={4} placeholder="اذكر نطاق العمل والمتطلبات..." /></label>
          <label className="form-field">المدينة<input value={formCity} onChange={(event) => setFormCity(event.target.value)} maxLength={100} placeholder="المدينة المطلوبة" /></label>
          {selectedService.category === "توفير العمالة" && <div className="notice warning">يجب تنفيذ التوظيف والتوفير عبر جهات مرخصة ووفق الأنظمة السعودية؛ لا يُعد هذا الطلب تحققًا من التراخيص.</div>}
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="primary-button auth-submit" type="submit" disabled={busy}>{busy ? "جارٍ الإرسال..." : "إرسال طلب الخدمة"}</button>
        </form>}
      </section>
    </div>}
  </div>;
}

function coverageValues(coverage: PublicService["coverage"]): string[] {
  if (Array.isArray(coverage)) return coverage.filter((value): value is string => typeof value === "string");
  if (typeof coverage === "string") {
    try {
      const parsed: unknown = JSON.parse(coverage);
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

function AuthenticationPage({ onAuthenticated, serverError, ownerPortal }: {
  onAuthenticated: () => Promise<void>;
  serverError: string;
  ownerPortal: boolean;
}) {
  const [mode, setMode] = useState<AuthMode>("login");
  const registrationType = new URLSearchParams(window.location.search).get("type");
  const initialCompanyType = ["customer", "supplier", "service_provider", "logistics_provider"].includes(registrationType ?? "")
    ? registrationType!
    : "customer";
  const [values, setValues] = useState<Record<string, string>>({ companyType: initialCompanyType });
  const [error, setError] = useState(serverError);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const body = mode === "login"
        ? { email: values.email, password: values.password }
        : {
          fullName: values.fullName, email: values.email, password: values.password,
          companyName: values.companyName, companyType: values.companyType,
          ...(values.registrationNumber ? { registrationNumber: values.registrationNumber } : {}),
          ...(values.taxNumber ? { taxNumber: values.taxNumber } : {}),
          ...(values.phone ? { phone: values.phone } : {}),
        };
      await apiRequest(mode === "login" ? "/auth/login" : "/auth/register", { method: "POST", body });
      await onAuthenticated();
      const returnTo = new URLSearchParams(window.location.search).get("returnTo");
      if (returnTo === "/supply" || returnTo === "/services") window.location.assign(returnTo);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذر تسجيل الدخول.");
    } finally {
      setBusy(false);
    }
  }

  const set = (key: string, value: string) => setValues((current) => ({ ...current, [key]: value }));

  return (
    <main className="auth-page">
      <section className="auth-brand-panel">
        <div className="auth-brand"><img className="brand-logo" src="/central-business-hub-logo.svg" alt="" /><div><strong>مركز الأعمال</strong><small>Central Business Hub</small></div></div>
        <div className="auth-brand-copy"><span className="eyebrow">منظومة الأعمال B2B</span><h1>من الطلب إلى<br />إتمام التوريد.</h1><p>بوابة تشغيل واحدة تربط الشركات بالموردين والخدمات والنقل والمخزون، مع متابعة موثقة لكل خطوة.</p></div>
        <img className="brand-decoration" src="/central-business-hub-logo.svg" alt="" aria-hidden="true" />
        <p className="auth-footer-copy">إدارة متكاملة لسلاسل الإمداد والخدمات بين الشركات.</p>
        <nav className="auth-portal-links" aria-label="بوابات المنظومة">
          <a href="/">الرئيسية</a><a href="/supply">سوق التوريد</a><a href="/services">دليل الخدمات</a>
        </nav>
      </section>
      <section className="auth-form-panel">
        <div className="auth-mobile-brand"><img className="brand-logo" src="/central-business-hub-logo.svg" alt="" /><strong>مركز الأعمال</strong></div>
        <div className="auth-card">
          <div className="auth-heading"><span className="eyebrow">{ownerPortal ? "منطقة مالك المنصة" : "بوابة الشركات"}</span><h2>{mode === "login" ? ownerPortal ? "دخول مالك المنصة" : "مرحبًا بعودتك" : "إنشاء حساب شركة"}</h2><p>{ownerPortal ? "سجّل الدخول بحساب المالك المهيأ مسبقًا؛ لا يمكن إنشاء صلاحية المالك من التسجيل العام." : mode === "login" ? "سجّل الدخول للوصول إلى حساب شركتك." : "أدخل بيانات المنشأة لبدء مراجعة الحساب."}</p></div>
          {!ownerPortal && <div className="auth-tabs"><button className={mode === "login" ? "selected" : ""} onClick={() => { setMode("login"); setError(""); }}>تسجيل الدخول</button><button className={mode === "register" ? "selected" : ""} onClick={() => { setMode("register"); setError(""); }}>حساب جديد</button></div>}
          {error && <div className="form-error" role="alert">{error}</div>}
          <form onSubmit={submit} className="auth-form">
            {mode === "register" && <>
              <label className="form-field">اسم المستخدم<input required minLength={2} maxLength={120} value={values.fullName ?? ""} onChange={(event) => set("fullName", event.target.value)} autoComplete="name" /></label>
              <label className="form-field">اسم الشركة<input required minLength={2} maxLength={200} value={values.companyName ?? ""} onChange={(event) => set("companyName", event.target.value)} autoComplete="organization" /></label>
              <label className="form-field">نوع الحساب<select value={values.companyType} onChange={(event) => set("companyType", event.target.value)}>
                <option value="customer">عميل / شركة مشترية</option><option value="supplier">مورد / مصنع</option><option value="service_provider">مقدم خدمات</option><option value="logistics_provider">شركة نقل ولوجستيات</option>
              </select></label>
              <div className="form-two-columns"><label className="form-field">السجل التجاري<input maxLength={80} value={values.registrationNumber ?? ""} onChange={(event) => set("registrationNumber", event.target.value)} /></label><label className="form-field">الرقم الضريبي<input maxLength={80} value={values.taxNumber ?? ""} onChange={(event) => set("taxNumber", event.target.value)} /></label></div>
              <label className="form-field">رقم التواصل<input maxLength={40} value={values.phone ?? ""} onChange={(event) => set("phone", event.target.value)} autoComplete="tel" /></label>
            </>}
            <label className="form-field">البريد الإلكتروني<input type="email" required maxLength={254} value={values.email ?? ""} onChange={(event) => set("email", event.target.value)} autoComplete="email" /></label>
            <label className="form-field">كلمة المرور<input type="password" required minLength={mode === "register" ? 12 : 1} maxLength={128} value={values.password ?? ""} onChange={(event) => set("password", event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} />{mode === "register" && <small>١٢ حرفًا على الأقل مع أحرف كبيرة وصغيرة ورقم ورمز.</small>}</label>
            {mode === "register" && <p className="auth-disclaimer">بعد التسجيل، تُراجع بيانات الشركة قبل إتاحة عمليات الشراء والتوريد. لن يُفعّل حساب الإدارة عبر التسجيل العام.</p>}
            <button type="submit" className="primary-button auth-submit" disabled={busy}>{busy ? "جارٍ التحقق..." : mode === "login" ? "تسجيل الدخول" : "إنشاء الحساب"}</button>
          </form>
          <p className="auth-privacy">جلسات الدخول محمية بملفات ارتباط آمنة، وبيانات كل شركة معزولة عن الشركات الأخرى.</p>
        </div>
        <span className="auth-version">Central Business Hub · بوابة آمنة</span>
      </section>
    </main>
  );
}

function Workspace({ session, onSessionChange }: { session: UserSession; onSessionChange: () => Promise<void> }) {
  const [activeSection, setActiveSection] = useState<SectionId>(() => {
    const requestedSection = new URLSearchParams(window.location.search).get("section");
    return navigation.find((item) => item.id === requestedSection)?.id
      ?? (window.location.pathname === "/owner" ? "administration" : "overview");
  });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [companyMenuOpen, setCompanyMenuOpen] = useState(false);
  const [switchingCompany, setSwitchingCompany] = useState(false);
  const [toast, setToast] = useState("");
  const [workspaceRefreshToken, setWorkspaceRefreshToken] = useState(0);
  const companyType = session.activeCompany.type;
  const availableNavigation = navigation.filter((item) =>
    item.companies.includes(companyType) && (item.id !== "administration" || session.activeCompany.role === "owner"));
  const page = titles[activeSection];

  useEffect(() => {
    if (availableNavigation.some((item) => item.id === activeSection)) return;
    setActiveSection("overview");
    const url = new URL(window.location.href);
    url.searchParams.delete("section");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [activeSection, availableNavigation]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function logout() {
    try {
      await apiRequest("/auth/logout", { method: "POST" });
      await onSessionChange();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "تعذر إنهاء الجلسة.");
    }
  }

  async function switchCompany(companyId: string) {
    if (companyId === session.activeCompany.id || switchingCompany) {
      setCompanyMenuOpen(false);
      return;
    }
    setSwitchingCompany(true);
    try {
      await apiRequest("/auth/switch-company", { method: "POST", body: { companyId } });
      setCompanyMenuOpen(false);
      setMobileNavOpen(false);
      await onSessionChange();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "تعذر تبديل مساحة الشركة.");
    } finally {
      setSwitchingCompany(false);
    }
  }

  function navigateSection(section: SectionId) {
    setActiveSection(section);
    setMobileNavOpen(false);
    const url = new URL(window.location.href);
    if (section === "overview" && url.pathname !== "/owner") url.searchParams.delete("section");
    else url.searchParams.set("section", section);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  return (
    <div className={`app-shell ${mobileNavOpen ? "mobile-nav-open" : ""}`}>
      <button className="mobile-nav-toggle" onClick={() => setMobileNavOpen((value) => !value)}
        aria-label={mobileNavOpen ? "إغلاق قائمة التنقل" : "فتح قائمة التنقل"} aria-expanded={mobileNavOpen} aria-controls="workspace-navigation">☰</button>
      <aside className="sidebar">
        <button className="brand brand-button" aria-label="العودة إلى لوحة المتابعة" onClick={() => { setActiveSection("overview"); setMobileNavOpen(false); }}>
          <span className="brand-mark">م</span><span><strong>مركز الأعمال</strong><small>Central Business Hub</small></span>
        </button>
        <div className="company-switcher">
          <button className="workspace-switcher" type="button" disabled={session.memberships.length < 2 || switchingCompany}
            aria-label="تبديل مساحة الشركة" aria-expanded={companyMenuOpen}
            onClick={() => setCompanyMenuOpen((open) => !open)}>
            <span className="workspace-avatar">{session.activeCompany.displayName.slice(0, 1)}</span>
            <span className="workspace-copy"><strong>{session.activeCompany.displayName}</strong><small>{companyTypeLabel(companyType)}</small></span>
            {session.memberships.length > 1 && <span className="chevron">⌄</span>}
          </button>
          {companyMenuOpen && session.memberships.length > 1 && <div className="company-menu" role="menu" aria-label="مساحات الشركة">
            {session.memberships.map((membership) => <button key={membership.company_id} type="button" role="menuitem"
              className={`company-option ${membership.company_id === session.activeCompany.id ? "active" : ""}`}
              onClick={() => void switchCompany(membership.company_id)}>
              <span className="workspace-copy"><strong>{membership.display_name}</strong><small>{companyTypeLabel(membership.type)} · {statusLabel(membership.status)}</small></span>
            </button>)}
          </div>}
        </div>
        <nav className="main-nav" id="workspace-navigation" aria-label="التنقل الرئيسي">
          {Array.from(new Set(availableNavigation.map((item) => item.group))).map((group) => (
            <div className="nav-group" key={group}><p className="nav-heading">{group}</p>
              {availableNavigation.filter((item) => item.group === group).map((item) => (
                <button key={item.id} className={`nav-item ${activeSection === item.id ? "active" : ""}`}
                  aria-label={item.label}
                  onClick={() => navigateSection(item.id)}>
                  <span className="nav-icon">{item.icon}</span><span>{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="help-card"><span className="help-icon">?</span><div><strong>مساعدة وتشغيل</strong><small>راجع مركز العمليات</small></div></div>
          <button className="profile-button" aria-label={`تسجيل الخروج، ${session.user.fullName}`} onClick={() => void logout()}>
            <span className="profile-avatar">{session.user.fullName.slice(0, 1)}</span>
            <span className="profile-copy"><strong>{session.user.fullName}</strong><small>تسجيل الخروج · {session.activeCompany.role}</small></span>
            <span className="chevron">↪</span>
          </button>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar"><div className="breadcrumbs"><span>{session.activeCompany.displayName}</span><span className="crumb-separator">/</span><strong>{page.title}</strong></div>
          <div className="topbar-actions"><nav className="ecosystem-links" aria-label="بوابات المنظومة"><a href="/">الرئيسية</a><a href="/supply">سوق التوريد</a><a href="/services">دليل الخدمات</a></nav><span className={`environment-badge ${session.activeCompany.status === "active" ? "active" : "pending"}`}><i />{session.activeCompany.status === "active" ? "شركة معتمدة" : "بانتظار الاعتماد"}</span><span className="topbar-user">{session.user.email}</span></div>
        </header>
        <div className="page-content">
          <div className="page-heading"><div><p className="eyebrow">{session.activeCompany.displayName}</p><h1>{page.title}</h1><p className="page-description">{page.description}</p></div>
            {activeSection !== "overview" && activeSection !== "analytics" && activeSection !== "operations" && activeSection !== "administration"
              && <ModuleActions section={activeSection} companyType={companyType} onSuccess={(message) => {
                setToast(message);
                setWorkspaceRefreshToken((value) => value + 1);
              }} />}
          </div>
          {session.activeCompany.status !== "active" && companyType !== "operator" && <div className="notice warning"><strong>حساب الشركة قيد المراجعة.</strong> سجّل بيانات المنشأة وانتظر اعتماد الإدارة قبل إنشاء طلبات أو عروض أو حركات تشغيلية.</div>}
          {toast && <div className="notice success" role="status">{toast}</div>}
          {activeSection === "overview" || activeSection === "analytics"
            ? <Dashboard companyType={companyType} detailed={activeSection === "analytics"} />
            : <WorkspacePage section={activeSection} companyType={companyType} onToast={setToast} refreshToken={workspaceRefreshToken} />}
          <footer className="page-footer"><span>مركز الأعمال · تشغيل متصل بقاعدة البيانات</span><span><i /> الاتصال بالخادم قيد المتابعة</span></footer>
        </div>
      </main>
      <div className="mobile-scrim" onClick={() => setMobileNavOpen(false)} />
    </div>
  );
}

function companyTypeLabel(type: CompanyType): string {
  const labels: Record<CompanyType, string> = {
    customer: "بوابة العملاء والشركات", supplier: "بوابة الموردين والمصانع",
    service_provider: "بوابة الخدمات", logistics_provider: "بوابة النقل واللوجستيات",
    operator: "إدارة المنظومة",
  };
  return labels[type];
}

function resourcesFor(section: SectionId, companyType: CompanyType): DataSource[] {
  const configured = sources[section] ?? [];
  if (section === "finance" && companyType !== "customer") {
    return configured.filter((source) => source.id === "invoices" || source.id === "subscriptions");
  }
  if (section === "inventory" && companyType !== "customer") {
    return configured.filter((source) => source.id !== "managedReplenishments");
  }
  if (section === "suppliers") return companyType === "supplier" ? configured.slice(0, 1) : configured.slice(1);
  if (section === "services") return companyType === "service_provider" ? configured.filter((source) => source.id !== "marketplace") : configured.filter((source) => source.id !== "listings");
  if (section === "logistics") return companyType === "logistics_provider" ? configured : configured.filter((source) => source.id === "shipments");
  if (section === "customers" && companyType === "operator") return [];
  return configured;
}

function ModuleActions({ section, companyType, onSuccess }: { section: SectionId; companyType: CompanyType; onSuccess: (message: string) => void }) {
  const forms: FormDefinition[] = [];
  if (section === "customers" && companyType === "customer") forms.push(formCatalog.profile, formCatalog.branch, formCatalog.member);
  if (section === "suppliers" && companyType === "supplier") forms.push(formCatalog.product);
  if (section === "services") {
    if (companyType === "service_provider") forms.push(formCatalog.service);
    if (companyType === "customer") forms.push(formCatalog.serviceRequest);
  }
  if (section === "procurement" && companyType === "customer") forms.push(formCatalog.rfq);
  if (section === "logistics") {
    if (companyType === "customer") forms.push(formCatalog.shipment);
    if (companyType === "logistics_provider") forms.push(formCatalog.carrierProfile, formCatalog.vehicle);
  }
  if (section === "inventory" && companyType === "customer") forms.push(formCatalog.warehouse, formCatalog.inventoryProduct, formCatalog.movement, formCatalog.transfer, formCatalog.count);
  if (section === "contracts" && companyType === "customer") forms.push(formCatalog.contract);
  if (section === "finance") {
    if (companyType === "supplier" || companyType === "service_provider" || companyType === "logistics_provider" || companyType === "operator") forms.push(formCatalog.invoice);
    if (companyType === "customer") forms.push(formCatalog.managedService, formCatalog.managedRule);
    forms.push(formCatalog.subscription);
  }
  if (section === "claims") forms.push(formCatalog.claim);
  if (section === "integrations") forms.push(formCatalog.integration);
  if (forms.length === 0) return null;
  return <div className="module-action-buttons">{forms.slice(0, 3).map((form) =>
    <FormLauncher key={form.id} form={form} onSuccess={(message) => { onSuccess(message); }} />,
  )}{forms.length > 3 && <details className="more-actions"><summary>المزيد</summary><div>{forms.slice(3).map((form) => <FormLauncher key={form.id} form={form} compact onSuccess={onSuccess} />)}</div></details>}</div>;
}

function FormLauncher({ form, onSuccess, compact = false }: { form: FormDefinition; onSuccess: (message: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <button className={compact ? "secondary-button" : "primary-button"} onClick={() => setOpen(true)}><span className="plus">+</span>{form.title}</button>
    {open && <FormDialog form={form} onClose={() => setOpen(false)} onSuccess={(message) => { setOpen(false); onSuccess(message); }} />}
  </>;
}

function Dashboard({ companyType, detailed }: { companyType: CompanyType; detailed: boolean }) {
  const [metrics, setMetrics] = useState<DataRow | null>(null);
  const [tower, setTower] = useState<DataRow | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      apiRequest<DataRow>("/analytics/dashboard", { signal: controller.signal }),
      ["customer", "supplier", "logistics_provider", "operator"].includes(companyType)
        ? apiRequest<DataRow>("/operations/control-tower", { signal: controller.signal })
        : Promise.resolve(null),
    ]).then(([dashboard, operations]) => {
      setMetrics(dashboard);
      setTower(operations);
      setError("");
    }).catch((cause: unknown) => {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "تعذر تحميل المؤشرات.");
    });
    return () => controller.abort();
  }, [companyType, detailed]);

  if (error) return <div className="form-error" role="alert">{error}</div>;
  if (!metrics) return <div className="loading-panel"><span className="spinner" /> جارٍ تحميل المؤشرات المسجلة...</div>;

  const stats = [
    { label: "إجمالي قيمة أوامر الشراء (GMV)", value: moneyByCurrency(metrics.gmvByCurrency), icon: "ر", tone: "blue" },
    { label: "مبالغ مسجلة كمحصّلة", value: moneyByCurrency(metrics.collectedPaymentsByCurrency), icon: "✓", tone: "green" },
    { label: "طلبات عروض مفتوحة", value: numeral(metrics.openRfqs), icon: "◷", tone: "amber" },
    { label: "الإيراد الشهري المتكرر", value: moneyByCurrency(metrics.subscriptionMrrByCurrency), icon: "↗", tone: "violet" },
    { label: "العملاء المعتمدون", value: numeral(metrics.activeCustomers), icon: "♙", tone: "blue" },
    { label: "الموردون المعتمدون", value: numeral(metrics.activeSuppliers), icon: "▤", tone: "green" },
    { label: "إتمام الشحنات", value: percent(metrics.shipmentFulfillmentPercent), icon: "⇢", tone: "amber" },
    { label: "دقة آخر جرد مكتمل", value: percent(metrics.latestInventoryAccuracyPercent), icon: "▣", tone: "violet" },
  ];
  const isOperator = companyType === "operator";
  const rows = [
    { key: "GMV", value: stats[0]!.value, note: "القيمة الإجمالية للطلبات غير الملغاة، وليست إيراد المنصة." },
    { key: "المبالغ المحصلة", value: stats[1]!.value, note: String(metrics.revenueDefinition ?? "") },
    { key: "التسليم في الموعد", value: percent(metrics.onTimeDeliveryPercent), note: "يحسب للشحنات المسلّمة التي لديها موعد مجدول." },
    { key: "دقة المخزون", value: percent(metrics.latestInventoryAccuracyPercent), note: String(metrics.inventoryAccuracyDefinition ?? "") },
  ];

  return <div className="dashboard-layout">
    <section className="stat-grid" aria-label="المؤشرات التشغيلية">
      {stats.map((stat) => <article className="stat-card" key={stat.label}><div className="stat-card-top"><span className="stat-label">{stat.label}</span><span className={`stat-icon ${stat.tone}`}>{stat.icon}</span></div><div className="stat-value">{stat.value}</div><div className="stat-foot"><span>من قاعدة البيانات</span></div></article>)}
    </section>
    <section className="dashboard-grid">
      <article className="panel"><div className="panel-heading"><div><h2>{isOperator ? "مراقبة المنظومة" : "متابعة العمليات"}</h2><p>الطلبات والشحنات والمطالبات التي تحتاج إلى إجراء</p></div><span className="live-tag"><i /> بيانات مباشرة</span></div>
        {tower ? <div className="operations-lists">
          <OperationList title="طلبات عروض مفتوحة" rows={asRows(tower.openRfqs)} empty="لا توجد طلبات عروض مفتوحة." nameKey="title" refKey="reference" statusKey="status" />
          <OperationList title="شحنات نشطة" rows={asRows(tower.activeShipments)} empty="لا توجد شحنات نشطة." nameKey="reference" statusKey="status" />
          <OperationList title="مطالبات مفتوحة" rows={asRows(tower.openClaims)} empty="لا توجد مطالبات مفتوحة." nameKey="title" refKey="reference" statusKey="status" />
        </div> : <p className="empty-note">يتطلب مركز العمليات أدوار العملاء والموردين والنقل.</p>}
      </article>
      <article className="panel definition-panel"><div className="panel-heading"><div><h2>تعريف المؤشرات</h2><p>لتجنب الخلط المحاسبي بين المبيعات والإيراد</p></div></div>
        <div className="definition-list">{rows.map((row) => <div key={row.key}><span>{row.key}</span><strong>{row.value}</strong><small>{row.note}</small></div>)}</div>
        <div className="data-note">القيم غير المتاحة تظهر —، ولا تُستبدل بأرقام تجريبية.</div>
      </article>
    </section>
    {detailed && <section className="panel detail-panel"><div className="panel-heading"><div><h2>نطاق البيانات</h2><p>{metrics.isPlatformWide ? "المؤشرات تشمل الشركات المعتمدة على مستوى المنظومة." : "المؤشرات مقيدة ببيانات مساحة شركتك."}</p></div></div><p className="data-note">{String(metrics.revenueDefinition ?? "")}</p></section>}
  </div>;
}

function moneyByCurrency(value: unknown): string {
  const amounts = asRows(value).flatMap((item) => {
    const currency = typeof item.currency === "string" ? item.currency : "";
    const amount = Number(item.amount);
    return /^[A-Z]{3}$/.test(currency) && Number.isFinite(amount)
      ? [`${new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 2 }).format(amount)} ${currency}`]
      : [];
  });
  return amounts.length ? amounts.join(" · ") : "—";
}
function numeral(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 0 }).format(number) : "—";
}
function percent(value: unknown): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return `${new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 2 }).format(Number(value))}٪`;
}
function asRows(value: unknown): DataRow[] { return Array.isArray(value) ? value as DataRow[] : []; }

function OperationList({ title, rows, empty, nameKey, refKey, statusKey }: {
  title: string; rows: DataRow[]; empty: string; nameKey: string; refKey?: string; statusKey: string;
}) {
  return <section className="operation-list"><div className="operation-list-heading"><strong>{title}</strong><span>{numeral(rows.length)}</span></div>
    {rows.length ? rows.slice(0, 5).map((row, index) => <div className="operation-row" key={String(row.id ?? index)}><span className="operation-dot" /><div><strong>{displayValue(row[nameKey])}</strong><small>{refKey ? displayValue(row[refKey]) : displayValue(row.createdAt)}</small></div><span className={`status-badge ${statusTone(row[statusKey])}`}>{displayValue(row[statusKey])}</span></div>) : <p className="empty-note">{empty}</p>}
  </section>;
}

function WorkspacePage({ section, companyType, onToast, refreshToken }: {
  section: SectionId; companyType: CompanyType; onToast: (message: string) => void; refreshToken: number;
}) {
  const pageSources = useMemo(() => resourcesFor(section, companyType), [section, companyType]);
  const [data, setData] = useState<Record<string, { rows: DataRow[]; error: string }>>({});
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<DataRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [quoteDialog, setQuoteDialog] = useState<{ rfqId: string } | null>(null);
  const [assignDialog, setAssignDialog] = useState<DataRow | null>(null);
  const [dispatchDialog, setDispatchDialog] = useState<DataRow | null>(null);
  const [actionDialog, setActionDialog] = useState<{ title: string; endpoint: string; method: string; body: Record<string, unknown>; fields: FieldDefinition[] } | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const entries = await Promise.all(pageSources.map(async (source) => {
      try {
        const payload = await apiRequest<unknown>(source.endpoint);
        return [source.id, { rows: normalizedRows(payload, source.responseKey), error: "" }] as const;
      } catch (cause) {
        return [source.id, { rows: [], error: cause instanceof Error ? cause.message : "تعذر تحميل البيانات." }] as const;
      }
    }));
    setData(Object.fromEntries(entries));
    setLoading(false);
  }, [pageSources]);

  useEffect(() => { void reload(); }, [reload, refreshToken]);

  async function performAction(source: DataSource, action: RowAction, row: DataRow) {
    const id = typeof row.id === "string" ? row.id : "";
    if (action.confirm && !window.confirm(action.confirm)) return;
    if (action.kind === "details" && source.id === "rfqs") {
      setDetailLoading(true);
      try { setDetail(await apiRequest<DataRow>(`/rfqs/${encodeURIComponent(id)}`)); }
      catch (error) { onToast(error instanceof Error ? error.message : "تعذر تحميل تفاصيل الطلب."); }
      finally { setDetailLoading(false); }
      return;
    }
    if (action.kind === "assign-shipment") { setAssignDialog(row); return; }
    if (action.kind === "dispatch-shipment") { setDispatchDialog(row); return; }
    if (action.kind === "form") {
      setActionDialog({ title: action.title ?? action.label, endpoint: action.endpoint(row), method: action.method ?? "PATCH", body: action.body?.(row) ?? {}, fields: action.fields ?? [] });
      return;
    }
    setBusyAction(id);
    try {
      await apiRequest(action.endpoint(row), { method: action.method ?? "POST", body: action.body?.(row) });
      onToast(action.successMessage ?? "تم حفظ التغيير.");
      await reload();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "تعذر تنفيذ الإجراء.");
    } finally {
      setBusyAction(null);
    }
  }

  if (loading && pageSources.length > 0) return <div className="loading-panel"><span className="spinner" /> جارٍ تحميل سجلات المنصة...</div>;
  if (pageSources.length === 0) return <div className="panel empty-panel"><h2>غير متاح لهذا النوع من الحسابات</h2><p>انتقل إلى مساحة الشركة أو المنصة المناسبة.</p></div>;

  return <>
    {section === "finance" && companyType === "customer" && <div className="notice warning">
      خدمة إعادة التوريد تعتمد على حركات المخزون المسجلة هنا، ولا تقرأ مستودعًا خارجيًا أو نظام ERP/POS. قبول عرض المورد ضمن السقوف ينشئ أمر شراء فقط؛ لا يوجد دفع آلي، ويُطلب الشحن وإسناد الناقل من قسم النقل والشحن.
    </div>}
    <div className="resource-grid">{pageSources.map((source) => {
      const result = data[source.id] ?? { rows: [], error: "" };
      if (source.id === "company" && result.rows[0]) {
        return <article className="panel resource-panel" key={source.id}><div className="panel-heading"><div><h2>{source.title}</h2><p>بيانات منشأة حسابك فقط</p></div><button className="text-button" onClick={() => setActionDialog({ title: "تحديث بيانات الشركة", endpoint: "/companies/me", method: "PATCH", body: {}, fields: formCatalog.profile.fields })}>تعديل البيانات</button></div>{result.error ? <ErrorNote message={result.error} /> : <KeyValueGrid row={result.rows[0]} />}</article>;
      }
      return <ResourcePanel key={source.id} source={source} rows={result.rows} error={result.error} companyType={companyType}
        busyAction={busyAction} onAction={(action, row) => void performAction(source, action, row)}
        onQuote={(row) => setQuoteDialog({ rfqId: String(row.id) })}
        onAssign={(row) => setAssignDialog(row)}
        onDispatch={(row) => setDispatchDialog(row)}
        onCount={(row) => void apiRequest<DataRow>(`/inventory/counts/${encodeURIComponent(String(row.id))}`).then(setDetail).catch((error: unknown) => onToast(error instanceof Error ? error.message : "تعذر فتح الجرد."))}
        onRefresh={() => void reload()} onToast={onToast} />;
    })}</div>
    {detailLoading && <div className="modal-backdrop"><div className="loading-panel"><span className="spinner" /> جارٍ جلب التفاصيل...</div></div>}
    {detail && section === "procurement" && <RfqDetailDialog detail={detail} companyType={companyType} onClose={() => setDetail(null)} onChanged={() => { setDetail(null); void reload(); }} onToast={onToast} />}
    {detail && section === "inventory" && <InventoryCountDialog count={detail} onClose={() => setDetail(null)} onChanged={() => { setDetail(null); void reload(); }} onToast={onToast} />}
    {quoteDialog && <FormDialog form={{ ...formCatalog.quote, endpoint: `/rfqs/${encodeURIComponent(quoteDialog.rfqId)}/quotes` }}
      onClose={() => setQuoteDialog(null)} onSuccess={(message) => { setQuoteDialog(null); onToast(message); void reload(); }} />}
    {assignDialog && <AssignShipmentDialog shipment={assignDialog} onClose={() => setAssignDialog(null)} onSuccess={(message) => { setAssignDialog(null); onToast(message); void reload(); }} />}
    {dispatchDialog && <DispatchShipmentDialog shipment={dispatchDialog} onClose={() => setDispatchDialog(null)} onSuccess={(message) => { setDispatchDialog(null); onToast(message); void reload(); }} />}
    {actionDialog && <ActionDialog title={actionDialog.title} endpoint={actionDialog.endpoint} method={actionDialog.method} initialBody={actionDialog.body} fields={actionDialog.fields}
      onClose={() => setActionDialog(null)} onSuccess={(message) => { setActionDialog(null); onToast(message); void reload(); }} />}
  </>;
}

type RowAction = {
  label: string;
  kind?: "details" | "assign-shipment" | "dispatch-shipment" | "form";
  endpoint: (row: DataRow) => string;
  method?: string;
  body?: (row: DataRow) => Record<string, unknown> | undefined;
  confirm?: string;
  successMessage?: string;
  title?: string;
  fields?: FieldDefinition[];
};

function actionsFor(sourceId: string, row: DataRow, companyType: CompanyType): RowAction[] {
  const id = String(row.id ?? "");
  const status = String(row.status ?? "");
  if (sourceId === "demoData" && companyType === "operator" && status !== "empty") return [{
    label: "حذف البيانات التجريبية نهائيًا",
    endpoint: () => "/admin/demo-data",
    method: "DELETE",
    confirm: "حذف جميع الموردين والمنتجات التجريبية؟ لن تُحذف بيانات الشركات الحقيقية.",
    successMessage: "تم حذف البيانات التجريبية.",
  }];
  if (sourceId === "managedRules" && companyType === "customer") return [{
    label: "تعديل تفويض الصنف",
    kind: "form",
    title: "تعديل حدود إعادة التوريد",
    endpoint: () => `/managed-inventory/rules/${encodeURIComponent(id)}`,
    method: "PATCH",
    fields: [
      sourceField("supplierCompanyId", "المورد المحدد", "/directory/companies?type=supplier"),
      field("reorderBelowQuantity", "حد بدء الطلب", "number"),
      field("reorderQuantity", "كمية إعادة التوريد", "number"),
      field("maxUnitPrice", "أعلى سعر للوحدة (ريال)", "money"),
      choiceField("isActive", "حالة القاعدة", [
        { value: "true", label: "مفعلة" }, { value: "false", label: "متوقفة" },
      ], false),
    ],
  }];
  if (sourceId === "managedServiceRequests" && companyType === "operator") {
    if (status === "requested") return [
      { label: "إرسال عرض شهري", kind: "form", title: "تسعير خدمة إدارة المخزون", endpoint: () => `/admin/managed-inventory/${encodeURIComponent(id)}/quote`, method: "PATCH", fields: [
        field("monthlyFee", "الرسوم الشهرية المقترحة (ريال)", "money", true),
        field("quoteNotes", "نطاق الخدمة والتسعير", "textarea", true),
      ] },
      { label: "رفض الطلب", endpoint: () => `/admin/managed-inventory/${encodeURIComponent(id)}/status`, method: "PATCH", body: () => ({ status: "rejected" }), confirm: "رفض طلب الخدمة وإبلاغ الشركة؟" },
    ];
  }
  if (sourceId === "managedServices" && companyType === "customer") {
    if (status === "quoted") return [
      { label: "قبول العرض وتفعيل الخدمة", endpoint: () => `/managed-inventory/services/${encodeURIComponent(id)}/accept`, confirm: "قبول الرسوم الشهرية المعروضة وتفعيل الخدمة؟ لا يوجد تحصيل آلي، والشراء الآلي محكوم بالسقوف التي أدخلتها.", successMessage: "قُبل عرض الخدمة." },
      { label: "إلغاء الطلب", endpoint: () => `/managed-inventory/services/${encodeURIComponent(id)}/cancel`, confirm: "إلغاء طلب الخدمة؟" },
    ];
    if (["requested", "active", "paused"].includes(status)) return [
      ...(status === "paused" ? [{ label: "استئناف الخدمة", endpoint: () => `/managed-inventory/services/${encodeURIComponent(id)}/resume`, confirm: "استئناف خدمة إدارة المخزون والتوريد وإعادة فحص المخزون؟" }] : []),
      { label: status === "requested" ? "إلغاء الطلب" : "إلغاء الخدمة", endpoint: () => `/managed-inventory/services/${encodeURIComponent(id)}/cancel`, confirm: "إلغاء طلب خدمة إدارة المخزون والتوريد؟" },
    ];
  }
  if (sourceId === "companies" && companyType === "operator") {
    if (status === "pending") return [
      { label: "اعتماد الشركة", endpoint: () => `/admin/companies/${encodeURIComponent(id)}/status`, method: "PATCH", body: () => ({ status: "active" }), confirm: "اعتماد بيانات الشركة وإتاحة المنصة لها؟", successMessage: "تم اعتماد الشركة." },
      { label: "تعليق", endpoint: () => `/admin/companies/${encodeURIComponent(id)}/status`, method: "PATCH", body: () => ({ status: "suspended" }), confirm: "تعليق تسجيل هذه الشركة؟" },
    ];
    if (status === "active") return [{ label: "تعليق", endpoint: () => `/admin/companies/${encodeURIComponent(id)}/status`, method: "PATCH", body: () => ({ status: "suspended" }), confirm: "تعليق وصول الشركة إلى المنصة؟" }];
    if (status === "suspended") return [{ label: "إعادة تفعيل", endpoint: () => `/admin/companies/${encodeURIComponent(id)}/status`, method: "PATCH", body: () => ({ status: "active" }), confirm: "إعادة تفعيل حساب الشركة؟" }];
  }
  if (sourceId === "rfqs") {
    const actions: RowAction[] = [{ label: "التفاصيل والعروض", kind: "details", endpoint: () => `/rfqs/${id}` }];
    if (companyType === "customer" && ["open", "reviewing", "partially_awarded"].includes(status)) {
      actions.push({ label: "إغلاق استقبال العروض", endpoint: () => `/rfqs/${id}/close`, confirm: "إغلاق الطلب وسحب العروض التي لم تُحسم؟", successMessage: "أُغلق استقبال العروض." });
      actions.push({ label: "إلغاء الطلب", endpoint: () => `/rfqs/${id}/cancel`, confirm: "إلغاء الطلب المفتوح وسحب العروض غير المحسومة؟" });
    } else if (companyType === "customer" && status === "draft") {
      actions.push({ label: "إلغاء الطلب", endpoint: () => `/rfqs/${id}/cancel`, confirm: "إلغاء الطلب؟" });
    }
    return actions;
  }
  if (sourceId === "orders") {
    if (companyType === "supplier" && status === "confirmed") return [{ label: "بدء التجهيز", endpoint: () => `/orders/${id}/status`, method: "PATCH", body: () => ({ status: "processing" }) }];
    if (companyType === "supplier" && status === "processing") return [{ label: "تحديث التنفيذ", endpoint: () => `/orders/${id}/status`, method: "PATCH", body: () => ({ status: "partially_fulfilled" }) }];
    if (companyType === "customer" && status === "confirmed") return [{ label: "إلغاء الطلب", endpoint: () => `/orders/${id}/status`, method: "PATCH", body: () => ({ status: "cancelled" }), confirm: "إلغاء أمر الشراء؟ لا يمكن إلغاء أمر بدأ المورد تجهيزه." }];
    if (companyType === "customer" && ["confirmed", "processing", "partially_fulfilled"].includes(status)) return [{ label: "تأكيد الاستلام", endpoint: () => `/orders/${id}/complete`, body: () => ({ confirmReceipt: true }), confirm: "لا تؤكد الاستلام إلا بعد وصول كل الشحنات المرتبطة والتحقق من الكميات." }];
  }
  if (sourceId === "serviceRequests") {
    if (companyType === "service_provider" && status === "open") return [{ label: "قبول الطلب", endpoint: () => `/service-requests/${id}/status`, method: "PATCH", body: () => ({ status: "accepted" }) }];
    if (companyType === "service_provider" && status === "accepted") return [{ label: "بدء التنفيذ", endpoint: () => `/service-requests/${id}/status`, method: "PATCH", body: () => ({ status: "in_progress" }) }];
    if (companyType === "service_provider" && status === "in_progress") return [{ label: "إكمال الخدمة", endpoint: () => `/service-requests/${id}/status`, method: "PATCH", body: () => ({ status: "completed" }) }];
    if (companyType === "customer" && ["open", "accepted"].includes(status)) return [{ label: "إلغاء الطلب", endpoint: () => `/service-requests/${id}/status`, method: "PATCH", body: () => ({ status: "cancelled" }), confirm: "إلغاء طلب الخدمة؟" }];
  }
  if (sourceId === "shipments") {
    if (companyType === "customer" && status === "pending") return [{ label: "إسناد إلى ناقل", kind: "assign-shipment", endpoint: () => "" }, { label: "إلغاء الشحنة", endpoint: () => `/shipments/${id}/status`, method: "PATCH", body: () => ({ status: "cancelled" }), confirm: "إلغاء الشحنة قبل إسنادها؟" }];
    if (companyType === "logistics_provider" && status === "assigned" && !row.carrierVehicleId) return [{ label: "تجهيز المركبة والسائق", kind: "dispatch-shipment", endpoint: () => "" }];
    const nextStatus: Record<string, string> = { assigned: "picked_up", picked_up: "in_transit" };
    if (companyType === "logistics_provider" && nextStatus[status]) return [{ label: status === "assigned" ? "تأكيد الاستلام" : "بدء النقل", endpoint: () => `/shipments/${id}/status`, method: "PATCH", body: () => ({ status: nextStatus[status] }) }];
    if (companyType === "logistics_provider" && status === "in_transit") return [
      { label: "إثبات التسليم", kind: "form", title: "إثبات التسليم", endpoint: () => `/shipments/${id}/status`, fields: [
        field("proofOfDeliveryUrl", "رابط HTTPS لإثبات التسليم", "url", true), field("location", "موقع التسليم"),
      ], body: () => ({ status: "delivered" }) },
      { label: "تسجيل استثناء", kind: "form", title: "تسجيل استثناء الشحنة", endpoint: () => `/shipments/${id}/status`, fields: [field("location", "الموقع"), field("notes", "تفاصيل الاستثناء", "textarea", true)], body: () => ({ status: "exception" }) },
    ];
    if (companyType === "logistics_provider" && status === "exception") return [{ label: "استئناف النقل", endpoint: () => `/shipments/${id}/status`, method: "PATCH", body: () => ({ status: "in_transit" }) }];
  }
  if (sourceId === "contracts") {
    if (["draft", "pending_approval"].includes(status)) return [{ label: "توقيع شركتي", endpoint: () => `/contracts/${id}/sign`, confirm: "التوقيع يسجل موافقة شركتك على بنود العقد. المتابعة تتطلب توقيع الطرف الآخر.", successMessage: "تم تسجيل موافقة شركتك." }];
    if (status === "active") return [{ label: "إنهاء العقد", endpoint: () => `/contracts/${id}/terminate`, confirm: "إنهاء العقد النشط؟" }];
  }
  if (sourceId === "invoices") {
    if (status === "draft" && row.issuerCompanyId) return [{ label: "إصدار الفاتورة", endpoint: () => `/invoices/${id}/issue`, confirm: "إصدار الفاتورة؟ لا يمكن تعديل مبالغها بعد الإصدار." }];
    if (["issued", "partially_paid", "overdue"].includes(status) && companyType !== "customer") return [{ label: "تسجيل دفعة خارجية", kind: "form", title: "تسجيل دفعة مستلمة", endpoint: () => `/invoices/${id}/payments`, method: "POST", fields: [
      field("amount", "المبلغ", "money", true),
      choiceField("method", "طريقة الدفع", [{ value: "bank_transfer", label: "تحويل بنكي" }, { value: "external_payment_provider", label: "مزود دفع خارجي" }, { value: "other", label: "أخرى" }]),
      field("externalReference", "مرجع العملية لدى الجهة الخارجية", "text", true),
    ] }];
  }
  if (sourceId === "claims") {
    if (["open", "under_review"].includes(status)) return [
      { label: "بدء المراجعة", endpoint: () => `/claims/${id}/status`, method: "PATCH", body: () => ({ status: "under_review" }) },
      { label: "حل المطالبة", kind: "form", title: "تسجيل نتيجة المطالبة", endpoint: () => `/claims/${id}/status`, body: () => ({ status: "resolved" }), fields: [field("resolution", "تفاصيل الحل", "textarea", true)] },
    ];
    if (companyType === "customer" && status === "resolved") return [{ label: "إغلاق المطالبة", endpoint: () => `/claims/${id}/status`, method: "PATCH", body: () => ({ status: "closed" }), confirm: "تأكيد إغلاق المطالبة؟" }];
  }
  if (sourceId === "invoices" && companyType === "customer") return [];
  if (sourceId === "counts") return [];
  if (sourceId === "subscriptions" && ["trialing", "active", "past_due"].includes(status)) return [{ label: "إلغاء الاشتراك", endpoint: () => `/subscriptions/${id}/cancel`, confirm: "إلغاء فترة الاشتراك الحالية؟" }];
  if (sourceId === "integrations" && status !== "disabled") return [{ label: "تعطيل", endpoint: () => `/integrations/${id}/status`, method: "PATCH", body: () => ({ status: "disabled" }) }];
  return [];
}

function ResourcePanel({ source, rows, error, companyType, busyAction, onAction, onQuote, onAssign, onDispatch, onCount, onRefresh, onToast }: {
  source: DataSource; rows: DataRow[]; error: string; companyType: CompanyType; busyAction: string | null;
  onAction: (action: RowAction, row: DataRow) => void; onQuote: (row: DataRow) => void; onAssign: (row: DataRow) => void;
  onDispatch: (row: DataRow) => void; onCount: (row: DataRow) => void; onRefresh: () => void;
  onToast: (message: string) => void;
}) {
  const columns = source.columns ?? (rows[0] ? Object.keys(rows[0]).filter((key) => key !== "id").slice(0, 6) : []);
  const [editing, setEditing] = useState(false);
  const formForSource = source.id === "carrierProfile" ? formCatalog.carrierProfile : undefined;
  const emptyLabel = source.id === "products" ? "لم تضف منتجات إلى كتالوج شركتك بعد." : "لا توجد سجلات محفوظة.";
  return <article className={`panel resource-panel ${source.id === "company" ? "wide-panel" : ""}`}>
    <div className="panel-heading"><div><h2>{source.title}</h2><p>{error ? "تعذر تحميل البيانات" : `${numeral(rows.length)} سجل محفوظ`}</p></div>
      <div className="panel-heading-actions">{formForSource && <button className="text-button" onClick={() => setEditing(true)}>تعديل التغطية</button>}<button className="icon-button refresh-button" onClick={onRefresh} aria-label="إعادة تحميل البيانات">↻</button></div>
    </div>
    {error ? <ErrorNote message={error} /> : rows.length === 0 ? <p className="empty-note">{emptyLabel}</p> : columns.length === 0 ? <KeyValueGrid row={rows[0]!} /> : <div className="table-wrap">
      <table><thead><tr>{columns.map((column) => <th key={column}>{labelFor(column)}</th>)}<th className="actions-heading">إجراءات</th></tr></thead>
        <tbody>{rows.map((row, index) => {
          const rowActions = actionsFor(source.id, row, companyType);
          return <tr key={String(row.id ?? `${source.id}-${index}`)}>
            {columns.map((column) => <td key={column}>{renderCell(column, row[column])}</td>)}
            <td><div className="row-actions">
              {source.id === "rfqs" && companyType === "supplier" && !row.myQuoteId && ["open", "reviewing", "partially_awarded"].includes(String(row.status))
                && <button className="table-action" onClick={() => onQuote(row)}>تقديم عرض</button>}
              {source.id === "shipments" && companyType === "customer" && row.status === "pending"
                && <button className="table-action" onClick={() => onAssign(row)}>إسناد ناقل</button>}
              {source.id === "shipments" && companyType === "logistics_provider" && row.status === "assigned" && !row.carrierVehicleId
                && <button className="table-action" onClick={() => onDispatch(row)}>تجهيز المركبة</button>}
                    {source.id === "counts" && row.status === "open" && <button className="table-action" onClick={() => onCount(row)}>متابعة الجرد</button>}
              {rowActions.filter((action) => !["assign-shipment", "dispatch-shipment"].includes(action.kind ?? "")).map((action) =>
                <button className="table-action" key={action.label} disabled={busyAction === String(row.id)} onClick={() => onAction(action, row)}>{action.label}</button>)}
            </div></td>
          </tr>;
        })}</tbody>
      </table>
    </div>}
    {editing && formForSource && <FormDialog form={formForSource} endpointOverride={formForSource.endpoint} methodOverride="PUT"
      initialValues={rows[0] ?? {}} onClose={() => setEditing(false)} onSuccess={(message) => { setEditing(false); onToast(message); onRefresh(); }} />}
  </article>;
}

function renderCell(key: string, value: unknown): ReactNode {
  if (key === "_group") {
    const groups: Record<string, string> = {
      openRfqs: "طلب عروض مفتوح",
      activeShipments: "شحنة نشطة",
      openClaims: "مطالبة مفتوحة",
      lowStock: "مخزون منخفض",
      expiring: "قرب انتهاء الصلاحية",
    };
    return groups[String(value)] ?? displayValue(value);
  }
  if (key === "status") return <span className={`status-badge ${statusTone(value)}`}>{statusLabel(value)}</span>;
  if (["perOrderBudget", "monthlyBudget", "monthlyFee", "maxUnitPrice", "authorizedAmount"].includes(key)
    && value !== null && value !== undefined && Number.isFinite(Number(value))) {
    return `${new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 2 }).format(Number(value))} ر.س`;
  }
  if (key.endsWith("At") || key.endsWith("On") || key.endsWith("Date")) {
    if (typeof value === "string" && value) {
      const date = new Date(value);
      if (Number.isFinite(date.getTime())) return <span dir="ltr">{new Intl.DateTimeFormat("ar-SA", { dateStyle: "medium", ...(key.endsWith("At") ? { timeStyle: "short" as const } : {}) }).format(date)}</span>;
    }
  }
  if (typeof value === "string" && value.length > 60) return <span className="cell-clip" title={value}>{value}</span>;
  return displayValue(value);
}

function statusTone(value: unknown): string {
  const status = String(value ?? "");
  if (["active", "completed", "delivered", "paid", "accepted", "resolved", "fulfilled", "awarded"].includes(status)) return "complete";
  if (["pending", "trialing", "open", "draft", "pending_approval", "assigned", "submitted"].includes(status)) return "pending";
  if (["suspended", "cancelled", "rejected", "exception", "overdue", "past_due", "terminated"].includes(status)) return "danger";
  return "review";
}

function statusLabel(value: unknown): string {
  const status = String(value ?? "—");
  const labels: Record<string, string> = {
    active: "فعال", pending: "معلق", pending_approval: "بانتظار الاعتماد", suspended: "معلق",
    open: "مفتوح", reviewing: "قيد المراجعة", partially_awarded: "مرسى جزئيًا", awarded: "تمت الترسية", cancelled: "ملغي",
    draft: "مسودة", submitted: "مقدم", accepted: "مقبول", rejected: "مرفوض", withdrawn: "مسحوب",
    confirmed: "مؤكد", processing: "قيد التجهيز", partially_fulfilled: "منفذ جزئيًا",
    fulfilled: "منفذ", assigned: "مسند", picked_up: "تم الاستلام", in_transit: "في الطريق",
    delivered: "تم التسليم", exception: "استثناء", completed: "مكتمل", under_review: "قيد المعالجة",
    resolved: "تم الحل", closed: "مغلق", trialing: "فترة تجريبية", past_due: "متأخر",
    paid: "مدفوع", partially_paid: "مدفوع جزئيًا", issued: "صادر", overdue: "متأخر",
    void: "ملغى", terminated: "منتهٍ",
    requested: "بانتظار عرض السعر", quoted: "بانتظار موافقة العميل", paused: "متوقف مؤقتًا",
    requires_approval: "يتطلب موافقة", pending_quote: "بانتظار عرض المورد", ordered: "تم إنشاء أمر الشراء",
    awaiting_stock: "بانتظار تحديث المخزون",
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function KeyValueGrid({ row }: { row: DataRow }) {
  return <dl className="key-value-grid">{Object.entries(row).filter(([key, value]) => key !== "id" && value !== null && value !== undefined).map(([key, value]) =>
    <div key={key}><dt>{labelFor(key)}</dt><dd>{key === "status" ? <span className={`status-badge ${statusTone(value)}`}>{statusLabel(value)}</span> : displayValue(value)}</dd></div>)}</dl>;
}

function ErrorNote({ message }: { message: string }) { return <div className="inline-error" role="alert">{message}</div>; }

function RfqDetailDialog({ detail, companyType, onClose, onChanged, onToast }: {
  detail: DataRow; companyType: CompanyType; onClose: () => void; onChanged: () => void; onToast: (message: string) => void;
}) {
  const quotes = asRows(detail.quotes);
  async function respond(quoteId: string, action: "accept" | "reject") {
    try {
      const result = await apiRequest<{ reference?: string; status?: string }>(`/quotes/${encodeURIComponent(quoteId)}/${action}`, { method: "POST" });
      onToast(action === "accept" ? `تم اعتماد العرض وإنشاء أمر شراء ${result.reference ?? ""}.` : "تم رفض العرض.");
      onChanged();
    } catch (error) { onToast(error instanceof Error ? error.message : "تعذر تحديث العرض."); }
  }
  return <div className="modal-backdrop"><section className="modal detail-modal" role="dialog" aria-modal="true" aria-labelledby="rfq-detail-title">
    <div className="modal-header"><div><p className="eyebrow">{String(detail.reference ?? "")}</p><h2 id="rfq-detail-title">{String(detail.title ?? "تفاصيل طلب السعر")}</h2></div><button className="close-button" onClick={onClose} aria-label="إغلاق">×</button></div>
    <p className="detail-description">{String(detail.notes ?? "لا توجد ملاحظات إضافية.")}</p>
    <h3 className="subheading">بنود الطلب</h3><div className="detail-items">{asRows(detail.items).map((item) => <div key={String(item.id)}><strong>{String(item.description)}{item.supplierName ? <small className="rfq-item-owner">المورد المختص: {String(item.supplierName)}</small> : null}</strong><span>{String(item.quantity)} {String(item.unit)}</span></div>)}</div>
    <h3 className="subheading">عروض الموردين</h3>
    {quotes.length ? <div className="quote-list">{quotes.map((quote) => <div className="quote-row" key={String(quote.id)}><div><strong>{String(quote.supplierName ?? "عرض شركتك")}</strong><small>{String(quote.notes ?? "")}</small></div><strong>{moneyByCurrency([{ currency: quote.currency, amount: quote.totalAmount }])}</strong><span className={`status-badge ${statusTone(quote.status)}`}>{statusLabel(quote.status)}</span>
      {companyType === "customer" && quote.status === "submitted" && <div className="row-actions"><button className="table-action" onClick={() => void respond(String(quote.id), "accept")}>اعتماد وإنشاء أمر شراء</button><button className="table-action danger-action" onClick={() => void respond(String(quote.id), "reject")}>رفض</button></div>}
    </div>)}</div> : <p className="empty-note">لم تصل عروض بعد.</p>}
    <div className="modal-actions"><button className="secondary-button" onClick={onClose}>إغلاق</button></div>
  </section></div>;
}

function AssignShipmentDialog({ shipment, onClose, onSuccess }: { shipment: DataRow; onClose: () => void; onSuccess: (message: string) => void }) {
  const [carriers, setCarriers] = useState<DataRow[]>([]);
  const [carrierId, setCarrierId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const query = new URLSearchParams({
      pickupCity: String(shipment.pickupCity ?? ""), deliveryCity: String(shipment.deliveryCity ?? ""),
      temperature: String(shipment.temperatureRequirement ?? "ambient"),
      ...(shipment.estimatedWeightKg ? { weightKg: String(shipment.estimatedWeightKg) } : {}),
    });
    void apiRequest<{ data: DataRow[] }>(`/logistics/carriers?${query}`).then((result) => setCarriers(result.data)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "تعذر تحميل الناقلين."));
  }, [shipment]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await apiRequest(`/shipments/${encodeURIComponent(String(shipment.id))}/assign`, { method: "PATCH", body: { carrierCompanyId: carrierId } });
      onSuccess("أُسندت الشحنة إلى الناقل المتوافق.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تعذر إسناد الناقل."); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="assign-title">
    <div className="modal-header"><div><p className="eyebrow">{String(shipment.reference ?? "")}</p><h2 id="assign-title">إسناد الشحنة إلى ناقل</h2></div><button className="close-button" onClick={onClose} aria-label="إغلاق">×</button></div>
    <p className="modal-description">تُعرض شركات النقل المعتمدة التي تغطي مدينتي الاستلام والتسليم وتقبل متطلبات درجة الحرارة والحمولة.</p>
    <form className="modal-form" onSubmit={(event) => void submit(event)}><label className="form-field">شركة النقل<select required value={carrierId} onChange={(event) => setCarrierId(event.target.value)}><option value="">اختر الناقل المتوافق</option>{carriers.map((carrier) => <option key={String(carrier.id)} value={String(carrier.id)}>{String(carrier.displayName)} · {String(carrier.availableVehicles)} مركبة</option>)}</select></label>
      {carriers.length === 0 && !error && <p className="empty-note">لا توجد شركة نقل لديها ملف تغطية ومركبة متاحة تطابق هذه الشحنة.</p>}
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>إلغاء</button><button className="primary-button" disabled={busy || !carriers.length}>{busy ? "جارٍ الإسناد..." : "إسناد الناقل"}</button></div>
    </form>
  </section></div>;
}

function DispatchShipmentDialog({ shipment, onClose, onSuccess }: { shipment: DataRow; onClose: () => void; onSuccess: (message: string) => void }) {
  const [vehicles, setVehicles] = useState<DataRow[]>([]);
  const [drivers, setDrivers] = useState<DataRow[]>([]);
  const [vehicleId, setVehicleId] = useState("");
  const [driverUserId, setDriverUserId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void Promise.all([
      apiRequest<{ data: DataRow[] }>("/logistics/vehicles"),
      apiRequest<{ data: DataRow[] }>("/logistics/drivers"),
    ]).then(([vehicleResult, driverResult]) => { setVehicles(vehicleResult.data.filter((vehicle) => vehicle.isActive)); setDrivers(driverResult.data); })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "تعذر تحميل المركبات والسائقين."));
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await apiRequest(`/shipments/${encodeURIComponent(String(shipment.id))}/dispatch`, {
        method: "PATCH", body: { vehicleId, ...(driverUserId ? { driverUserId } : {}) },
      });
      onSuccess("تم إسناد المركبة وتجهيز الشحنة.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تعذر تجهيز الشحنة."); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="dispatch-title">
    <div className="modal-header"><div><p className="eyebrow">{String(shipment.reference ?? "")}</p><h2 id="dispatch-title">تجهيز الشحنة</h2></div><button className="close-button" onClick={onClose} aria-label="إغلاق">×</button></div>
    <form className="modal-form" onSubmit={(event) => void submit(event)}>
      <label className="form-field">مركبة ملائمة<select required value={vehicleId} onChange={(event) => setVehicleId(event.target.value)}><option value="">اختر المركبة</option>{vehicles.map((vehicle) => <option key={String(vehicle.id)} value={String(vehicle.id)}>{String(vehicle.vehicleType)} · {String(vehicle.plateNumber)} · {String(vehicle.maxPayloadKg)} كجم</option>)}</select></label>
      <label className="form-field">السائق (اختياري)<select value={driverUserId} onChange={(event) => setDriverUserId(event.target.value)}><option value="">غير محدد</option>{drivers.map((driver) => <option key={String(driver.id)} value={String(driver.id)}>{String(driver.fullName)} · {String(driver.email)}</option>)}</select></label>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>إلغاء</button><button className="primary-button" disabled={busy || !vehicles.length}>{busy ? "جارٍ الحفظ..." : "تجهيز الشحنة"}</button></div>
    </form>
  </section></div>;
}

function ActionDialog({ title, endpoint, method, initialBody, fields, onClose, onSuccess }: {
  title: string; endpoint: string; method: string; initialBody: Record<string, unknown>; fields: FieldDefinition[];
  onClose: () => void; onSuccess: (message: string) => void;
}) {
  const form: FormDefinition = { id: "action", title, endpoint, fields };
  return <FormDialog form={form} endpointOverride={endpoint} methodOverride={method}
    initialBody={initialBody} onClose={onClose} onSuccess={onSuccess} />;
}

function InventoryCountDialog({ count, onClose, onChanged, onToast }: {
  count: DataRow; onClose: () => void; onChanged: () => void; onToast: (message: string) => void;
}) {
  const items = asRows(count.items);
  const [quantities, setQuantities] = useState<Record<string, string>>(() => Object.fromEntries(items.map((item) => [String(item.id), String(item.countedQuantity ?? "0")])));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function saveItem(item: DataRow): Promise<boolean> {
    const itemId = String(item.id);
    try {
      await apiRequest(`/inventory/counts/${encodeURIComponent(String(count.id))}/items/${encodeURIComponent(itemId)}`, {
        method: "PUT", body: { countedQuantity: Number(quantities[itemId]) },
      });
      setError("");
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تعذر حفظ الجرد."); }
    return false;
  }
  async function complete() {
    setBusy(true);
    try {
      for (const item of items) {
        if (!(await saveItem(item))) return;
      }
      const result = await apiRequest<{ inventoryAccuracy: number }>(`/inventory/counts/${encodeURIComponent(String(count.id))}/complete`, { method: "POST" });
      onToast(`اكتمل الجرد. دقة المطابقة ${percent(result.inventoryAccuracy * 100)}.`);
      onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تعذر إكمال الجرد."); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><section className="modal detail-modal count-modal" role="dialog" aria-modal="true" aria-labelledby="count-title">
    <div className="modal-header"><div><p className="eyebrow">مستودع {String(count.warehouseId ?? "")}</p><h2 id="count-title">مطابقة الجرد</h2></div><button className="close-button" onClick={onClose} aria-label="إغلاق">×</button></div>
    <p className="modal-description">أدخل الكمية التي عُدّت فعليًا. عند الإكمال تسجل فروقات الجرد كحركات تسوية قابلة للتدقيق.</p>
    <div className="count-items">{items.map((item) => <div className="count-row" key={String(item.id)}><div><strong>{String(item.productName)}</strong><small>الكمية المسجلة: {String(item.expectedQuantity)} {String(item.unit)}</small></div><input aria-label={`الكمية الفعلية ${String(item.productName)}`} type="number" step="0.001" min="0" value={quantities[String(item.id)] ?? ""} onChange={(event) => setQuantities((current) => ({ ...current, [String(item.id)]: event.target.value }))} /></div>)}
      {items.length === 0 && <p className="empty-note">لا توجد أصناف في المستودع. أضف الأصناف وسجل حركاتها قبل الجرد.</p>}
    </div>
    {error && <div className="form-error">{error}</div>}
    <div className="modal-actions"><button className="secondary-button" onClick={onClose}>إغلاق</button>{count.status === "open" && <button className="primary-button" disabled={busy || items.length === 0} onClick={() => void complete()}>{busy ? "جارٍ إكمال الجرد..." : "حفظ الفروقات وإغلاق الجرد"}</button>}</div>
  </section></div>;
}

function FormDialog({ form, endpointOverride, methodOverride, initialValues, initialBody, onClose, onSuccess }: {
  form: FormDefinition; endpointOverride?: string; methodOverride?: string; initialValues?: DataRow;
  initialBody?: Record<string, unknown>;
  onClose: () => void; onSuccess: (message: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(
    Object.entries(initialValues ?? {}).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => [key, String(value)]),
  ));
  const [options, setOptions] = useState<Record<string, DataRow[]>>({});
  const [optionErrors, setOptionErrors] = useState<Record<string, string>>({});
  const [items, setItems] = useState([{ description: "", quantity: "1", unit: "" }]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = endpointOverride ?? form.endpoint;

  useEffect(() => {
    let active = true;
    const fields = form.fields.filter((item) => item.optionsEndpoint);
    void Promise.all(fields.map(async (item) => {
      try {
        const result = await apiRequest<unknown>(item.optionsEndpoint!);
        if (active) setOptions((current) => ({ ...current, [item.key]: normalizedRows(result) }));
      } catch (cause) {
        if (active) setOptionErrors((current) => ({ ...current, [item.key]: cause instanceof Error ? cause.message : "تعذر تحميل الخيارات." }));
      }
    }));
    return () => { active = false; };
  }, [form]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const body: Record<string, unknown> = { ...initialBody };
    for (const item of form.fields) {
      const value = values[item.key]?.trim() ?? "";
      if (!value) {
        if (item.required) { setError(`أدخل الحقل: ${item.label}`); return; }
        continue;
      }
      if (item.type === "number") {
        const number = Number(value);
        if (!Number.isFinite(number)) { setError(`القيمة في ${item.label} غير صحيحة.`); return; }
        body[item.key] = number;
      } else if (item.type === "datetime") {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) { setError(`التاريخ في ${item.label} غير صحيح.`); return; }
        body[item.key] = date.toISOString();
      } else if (item.type === "multi") {
        body[item.key] = value.split(",").map((part) => part.trim()).filter(Boolean);
      } else if (item.key === "coverage" || item.key === "coverageCities" || item.key === "transportTypes"
        || item.key === "temperatureCapabilities" || item.key === "deliveryRegions") {
        body[item.key] = value.split(",").map((part) => part.trim()).filter(Boolean);
      } else if (item.key === "isWarehouse") {
        body[item.key] = value === "true";
      } else if (item.key === "isIncrease") {
        body[item.key] = value === "true";
      } else if (item.key === "autoReorder") {
        body[item.key] = value === "true";
      } else if (item.key === "isActive") {
        body[item.key] = value === "true";
      } else if (item.type === "json") {
        try { body[item.key] = JSON.parse(value) as unknown; }
        catch { setError(`إعدادات JSON غير صالحة في ${item.label}.`); return; }
      } else {
        body[item.key] = value;
      }
    }
    if (form.itemRows) {
      const validItems = items.filter((item) => item.description.trim() && item.unit.trim() && Number(item.quantity) > 0);
      if (validItems.length === 0) { setError("أضف بندًا واحدًا على الأقل مع الوحدة والكمية."); return; }
      body.items = validItems.map((item) => ({ description: item.description.trim(), unit: item.unit.trim(), quantity: Number(item.quantity) }));
    }
    if (form.id === "movement") {
      const selected = options.inventoryProductId?.find((item) => item.id === body.inventoryProductId);
      if (!selected) { setError("اختر صنفًا صالحًا من سجل المخزون."); return; }
      if (body.movementType === "adjustment" && typeof body.isIncrease !== "boolean") {
        setError("حدد ما إذا كانت التسوية زيادة أم تخفيضًا.");
        return;
      }
      body.productName = selected.name;
      body.unit = selected.unit;
    }
    if (form.id === "carrierProfile") body.maxPayloadKg = values.maxPayloadKg ? Number(values.maxPayloadKg) : null;
    if (form.id === "service" && body.priceFrom !== undefined) body.priceFrom = Number(body.priceFrom);
    if (form.id === "quote") body.currency = String(body.currency ?? "SAR").toUpperCase();
    setBusy(true);
    try {
      const method = methodOverride ?? (form.id === "carrierProfile" ? "PUT" : form.id === "profile" ? "PATCH" : "POST");
      const saved = await apiRequest<{ status?: string; orderReference?: string | null }>(endpoint, { method, body });
      onSuccess(form.id === "quote" && saved.status === "accepted"
        ? `قُبل عرضك تلقائيًا ضمن حدود تفويض العميل وأنشئ أمر الشراء ${saved.orderReference ?? ""}.`
        : form.id === "quote" ? "تم إرسال العرض للمشتري."
          : form.id === "count" ? "بدأت جلسة الجرد."
        : form.id === "managedService" ? "تم إرسال طلب الخدمة؛ سيظهر عرض السعر الشهري بعد مراجعة مالك المنصة."
          : form.id === "managedRule" ? "تم حفظ حدود إعادة التوريد للصنف والمورد المحددين."
            : "تم حفظ العملية في قاعدة البيانات.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذر حفظ العملية.");
    } finally {
      setBusy(false);
    }
  }

  function set(key: string, value: string) { setValues((current) => ({ ...current, [key]: value })); }
  function fieldOptions(item: FieldDefinition): Array<{ value: string; label: string }> {
    if (item.options) return item.options;
    return (options[item.key] ?? []).map((option) => ({
      value: String(option.id ?? ""),
      label: item.key === "inventoryProductId" && typeof option.sourceSupplierName === "string"
        ? `${String(option.name ?? option.id)} — ${option.sourceSupplierName}`
        : String(option.displayName ?? option.name ?? option.reference ?? option.fullName ?? option.email ?? option.id ?? ""),
    })).filter((option) => option.value);
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal form-modal" role="dialog" aria-modal="true" aria-labelledby="form-modal-title">
      <div className="modal-header"><div><p className="eyebrow">عملية محفوظة</p><h2 id="form-modal-title">{form.title}</h2></div><button className="close-button" onClick={onClose} aria-label="إغلاق">×</button></div>
      <form className="modal-form" onSubmit={(event) => void submit(event)}>
        {form.fields.map((item) => {
          const value = values[item.key] ?? (item.key === "currency" ? "SAR" : "");
          const optionsList = fieldOptions(item);
          return <label className="form-field" key={item.key}>{item.label}{item.type === "textarea" || item.type === "json"
            ? <textarea required={item.required} value={value} onChange={(event) => set(item.key, event.target.value)} rows={item.type === "json" ? 3 : 4} placeholder={item.type === "json" ? "{}" : ""} />
            : item.type === "select" || item.type === "multi"
              ? <select required={item.required} multiple={item.type === "multi"} value={item.type === "multi" ? value ? value.split(",") : [] : value}
                onChange={(event) => set(item.key, item.type === "multi" ? Array.from(event.target.selectedOptions).map((option) => option.value).join(",") : event.target.value)}>
                {item.type !== "multi" && !item.required && <option value="">اختر —</option>}
                {optionsList.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              : <input type={item.type === "money" ? "text" : item.type === "datetime" ? "datetime-local" : item.type === "date" ? "date" : item.type ?? "text"}
                required={item.required} min={item.min} value={value} onChange={(event) => set(item.key, event.target.value)} step={item.type === "number" ? "0.001" : undefined} />}
            {item.hint && <small>{item.hint}</small>}
            {optionErrors[item.key] && <small className="field-error">{optionErrors[item.key]}</small>}
            {item.type === "multi" && optionsList.length === 0 && !optionErrors[item.key] && <small>لا توجد خيارات متاحة بعد.</small>}
          </label>;
        })}
        {form.itemRows && <div className="rfq-items-editor"><div className="rfq-items-heading"><strong>بنود الطلب</strong><button type="button" className="text-button" onClick={() => setItems((current) => [...current, { description: "", quantity: "1", unit: "" }])}>+ إضافة بند</button></div>
          {items.map((item, index) => <div className="rfq-item-row" key={index}><input value={item.description} onChange={(event) => setItems((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, description: event.target.value } : row))} aria-label="وصف البند" placeholder="وصف الصنف" /><input value={item.quantity} type="number" min="0.001" step="0.001" onChange={(event) => setItems((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, quantity: event.target.value } : row))} aria-label="الكمية" /><input value={item.unit} onChange={(event) => setItems((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, unit: event.target.value } : row))} aria-label="الوحدة" placeholder="الوحدة" /><button type="button" className="remove-item" onClick={() => setItems((current) => current.filter((_, rowIndex) => rowIndex !== index))} aria-label="حذف البند" disabled={items.length === 1}>×</button></div>)}
        </div>}
        {form.id === "quote" && <div className="demo-warning">العرض سيصبح مرئيًا للمشتري الذي دعا شركتك فقط.</div>}
        {form.id === "integration" && <div className="demo-warning">يسجل هذا النموذج إعدادًا فقط. لا تُرسل مفاتيح أو كلمات مرور؛ الربط المباشر يتطلب موصلًا معتمدًا.</div>}
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>إلغاء</button><button type="submit" className="primary-button" disabled={busy}>{busy ? "جارٍ الحفظ..." : "حفظ العملية"}</button></div>
      </form>
    </section>
  </div>;
}

export default App;

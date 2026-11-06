import { z } from "zod";
import { ApiError } from "./errors.js";

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const message = result.error.issues.map((issue) => `${issue.path.join(".") || "الطلب"}: ${issue.message}`).join("؛ ");
    throw new ApiError(400, message, "VALIDATION_FAILED");
  }
  return result.data;
}

export const uuidSchema = z.string().uuid();
export const emailSchema = z.string().trim().pipe(z.email().max(254)).transform((email) => email.toLowerCase());
export const passwordSchema = z.string().min(12).max(128).regex(/[a-z]/, "يجب أن تتضمن كلمة المرور حرفًا صغيرًا")
  .regex(/[A-Z]/, "يجب أن تتضمن كلمة المرور حرفًا كبيرًا")
  .regex(/[0-9]/, "يجب أن تتضمن كلمة المرور رقمًا")
  .regex(/[^A-Za-z0-9]/, "يجب أن تتضمن كلمة المرور رمزًا");
export const textSchema = (minimum = 1, maximum = 200) =>
  z.string().trim().min(minimum).max(maximum);
export const optionalTextSchema = (maximum = 2000) =>
  z.string().trim().max(maximum).optional().transform((value) => value || null);
export const quantitySchema = z.coerce.number().finite().positive().max(1_000_000_000);
export const productPriceTierSchema = z.object({
  minimumQuantity: quantitySchema,
  unitPrice: z.number().finite().nonnegative().max(1_000_000_000),
}).strict();
export const productPriceTiersSchema = z.array(productPriceTierSchema).max(100).refine(
  (tiers) => new Set(tiers.map((tier) => tier.minimumQuantity)).size === tiers.length,
  "لا يمكن تكرار حد الكمية في شرائح الأسعار.",
);
export const productSpecificationsSchema = z.record(z.string().trim().min(1).max(80), z.union([
  z.string().trim().max(500),
  z.boolean(),
  z.number().finite(),
])).refine((value) => Object.keys(value).length <= 40, "لا يمكن إضافة أكثر من ٤٠ مواصفة.");

export function rfqAwardStatus(invitedCount: number, acceptedCount: number): "awarded" | "partially_awarded" {
  if (!Number.isInteger(invitedCount) || invitedCount < 1
    || !Number.isInteger(acceptedCount) || acceptedCount < 1 || acceptedCount > invitedCount) {
    throw new ApiError(500, "تعذر تحديد حالة ترسية الطلب.", "INVALID_RFQ_AWARD_COUNTS");
  }
  return acceptedCount === invitedCount ? "awarded" : "partially_awarded";
}

export function assertRfqProductConstraints(
  items: Array<{ productId?: string | undefined; quantity: number }>,
  products: Array<{ id: string; supplier_company_id: string; minimum_order_quantity: string }>,
  supplierIds: string[],
): void {
  const productById = new Map(products.map((product) => [product.id, product]));
  for (const item of items) {
    if (!item.productId) continue;
    const product = productById.get(item.productId);
    if (!product) throw new ApiError(400, "يتضمن الطلب منتجًا غير متاح.", "PRODUCT_NOT_AVAILABLE");
    if (!supplierIds.includes(product.supplier_company_id)) {
      throw new ApiError(400, "يجب دعوة المورد المالك لكل منتج محدد.", "PRODUCT_SUPPLIER_NOT_INVITED");
    }
    if (item.quantity < Number(product.minimum_order_quantity)) {
      throw new ApiError(400, "الكمية أقل من الحد الأدنى لطلب المنتج.", "MINIMUM_ORDER_QUANTITY_NOT_MET");
    }
  }
}

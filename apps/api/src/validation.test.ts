import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./errors.js";
import { isWithinReplenishmentLimits } from "./managed-inventory-policy.js";
import {
  assertRfqProductConstraints, emailSchema, parse, passwordSchema, productPriceTiersSchema,
  productSpecificationsSchema, quantitySchema, rfqAwardStatus, textSchema, uuidSchema,
} from "./validation.js";

test("text values are trimmed and enforce configured boundaries", () => {
  assert.equal(parse(textSchema(2, 20), "  شركة تجارية  "), "شركة تجارية");
  assert.throws(() => parse(textSchema(2, 20), " x "), (error: unknown) =>
    error instanceof ApiError && error.status === 400 && error.code === "VALIDATION_FAILED");
});

test("email values are normalized and invalid addresses are rejected", () => {
  assert.equal(parse(emailSchema, "  USER@Example.COM "), "user@example.com");
  assert.throws(() => parse(emailSchema, "not-an-email"), (error: unknown) =>
    error instanceof ApiError && error.code === "VALIDATION_FAILED");
});

test("quantities must be finite, positive, and within the supported limit", () => {
  assert.equal(parse(quantitySchema, "1.25"), 1.25);
  for (const quantity of ["0", "-1", "Infinity", "1000000001", "not-a-number"]) {
    assert.throws(() => parse(quantitySchema, quantity), ApiError);
  }
});

test("password policy requires length, mixed case, a number, and a symbol", () => {
  assert.equal(parse(passwordSchema, "SecurePass123!"), "SecurePass123!");
  for (const password of ["short1A!", "alllowercase123!", "ALLUPPERCASE123!", "NoNumberHere!!"]) {
    assert.throws(() => parse(passwordSchema, password), ApiError);
  }
});

test("UUID values are checked before reaching database queries", () => {
  assert.equal(parse(uuidSchema, "00000000-0000-4000-8000-000000000001"), "00000000-0000-4000-8000-000000000001");
  assert.throws(() => parse(uuidSchema, "123"), ApiError);
});

test("RFQs require inviting the owning supplier and meeting each product minimum", () => {
  const productId = "00000000-0000-4000-8000-000000000001";
  const supplierId = "00000000-0000-4000-8000-000000000002";
  const products = [{ id: productId, supplier_company_id: supplierId, minimum_order_quantity: "5" }];
  const items = [{ productId, quantity: 5 }];

  assert.doesNotThrow(() => assertRfqProductConstraints(items, products, [supplierId]));
  assert.throws(() => assertRfqProductConstraints(items, products, []), (error: unknown) =>
    error instanceof ApiError && error.code === "PRODUCT_SUPPLIER_NOT_INVITED");
  assert.throws(() => assertRfqProductConstraints([{ productId, quantity: 4 }], products, [supplierId]), (error: unknown) =>
    error instanceof ApiError && error.code === "MINIMUM_ORDER_QUANTITY_NOT_MET");
  assert.throws(() => assertRfqProductConstraints(items, [], [supplierId]), (error: unknown) =>
    error instanceof ApiError && error.code === "PRODUCT_NOT_AVAILABLE");
});

test("RFQ award status reflects partial and complete multi-supplier awards", () => {
  assert.equal(rfqAwardStatus(3, 1), "partially_awarded");
  assert.equal(rfqAwardStatus(3, 2), "partially_awarded");
  assert.equal(rfqAwardStatus(3, 3), "awarded");
  assert.throws(() => rfqAwardStatus(0, 0), (error: unknown) =>
    error instanceof ApiError && error.code === "INVALID_RFQ_AWARD_COUNTS");
  assert.throws(() => rfqAwardStatus(2, 3), (error: unknown) =>
    error instanceof ApiError && error.code === "INVALID_RFQ_AWARD_COUNTS");
});

test("managed replenishment only auto-accepts valid SAR quotes within every customer cap", () => {
  const limits = {
    quoteAmount: 120,
    currency: "SAR",
    perOrderBudget: 150,
    monthlyBudget: 300,
    monthlySpend: 100,
    reorderQuantity: 10,
    maxUnitPrice: 15,
    validUntil: "2099-12-31",
    today: "2099-01-01",
  };
  assert.equal(isWithinReplenishmentLimits(limits), true);
  assert.equal(isWithinReplenishmentLimits({ ...limits, quoteAmount: 151 }), false);
  assert.equal(isWithinReplenishmentLimits({ ...limits, monthlySpend: 190 }), false);
  assert.equal(isWithinReplenishmentLimits({ ...limits, quoteAmount: 151, perOrderBudget: 500 }), false);
  assert.equal(isWithinReplenishmentLimits({ ...limits, currency: "USD" }), false);
  assert.equal(isWithinReplenishmentLimits({ ...limits, validUntil: "2098-12-31" }), false);
});

test("public product volume prices must have unique positive quantity breaks", () => {
  assert.deepEqual(parse(productPriceTiersSchema, [
    { minimumQuantity: 10, unitPrice: 8.5 },
    { minimumQuantity: 5, unitPrice: 9 },
  ]), [
    { minimumQuantity: 10, unitPrice: 8.5 },
    { minimumQuantity: 5, unitPrice: 9 },
  ]);
  assert.throws(() => parse(productPriceTiersSchema, [
    { minimumQuantity: 5, unitPrice: 9 },
    { minimumQuantity: 5, unitPrice: 8 },
  ]), ApiError);
  assert.throws(() => parse(productPriceTiersSchema, [{ minimumQuantity: 0, unitPrice: 9 }]), ApiError);
});

test("product specifications accept bounded primitive values only", () => {
  assert.deepEqual(parse(productSpecificationsSchema, { material: "steel", certified: true, weightKg: 4.5 }), {
    material: "steel", certified: true, weightKg: 4.5,
  });
  assert.throws(() => parse(productSpecificationsSchema, { material: { value: "steel" } }), ApiError);
});

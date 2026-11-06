export type ReplenishmentLimits = {
  quoteAmount: number;
  currency: string;
  perOrderBudget: number;
  monthlyBudget: number;
  monthlySpend: number;
  reorderQuantity: number;
  maxUnitPrice: number;
  validUntil: string | null;
  today: string;
};

export function isWithinReplenishmentLimits(limits: ReplenishmentLimits): boolean {
  if (![limits.quoteAmount, limits.perOrderBudget, limits.monthlyBudget, limits.monthlySpend,
    limits.reorderQuantity, limits.maxUnitPrice].every(Number.isFinite)
    || limits.quoteAmount < 0
    || limits.perOrderBudget < 0
    || limits.monthlyBudget < 0
    || limits.monthlySpend < 0
    || limits.reorderQuantity <= 0
    || limits.maxUnitPrice <= 0) return false;
  const quoteCents = BigInt(Math.round(limits.quoteAmount * 100));
  const perOrderCents = BigInt(Math.round(limits.perOrderBudget * 100));
  const monthlyCents = BigInt(Math.round(limits.monthlyBudget * 100));
  const spentCents = BigInt(Math.round(limits.monthlySpend * 100));
  const quantityMilliunits = BigInt(Math.round(limits.reorderQuantity * 1000));
  const maxUnitPriceCents = BigInt(Math.round(limits.maxUnitPrice * 100));
  return limits.currency === "SAR"
    && quoteCents <= perOrderCents
    && quoteCents <= (quantityMilliunits * maxUnitPriceCents) / 1000n
    && spentCents + quoteCents <= monthlyCents
    && (!limits.validUntil || limits.validUntil >= limits.today);
}

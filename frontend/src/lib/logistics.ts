// ─── Smart Logistics Calculation Utility ────────────────────────────────────

export interface LogisticsConfig {
  unitWeight: number;
  weightUom: 'KG' | 'GRAM' | 'TON';
  maxWeight: number;
  dimensions: { length: number; width: number; height: number; unit: 'CM' | 'IN' } | null;
  transportTypes: ('AIR' | 'SHIP')[];
  // recommendedTransport: AIR (both markets) | SEA (.com only) | SURFACE (.in only)
  // | SHIP (legacy, both). SEA/SURFACE/SHIP all resolve to the SHIP transport type.
  weightRanges: Array<{ minWeight: number; maxWeight: number; recommendedTransport: 'AIR' | 'SHIP' | 'SEA' | 'SURFACE' }>;
  airDeliveryDays: number;
  // The SHIP lane means different things per market: SEA freight internationally (.com)
  // vs SURFACE / road domestically (.in). shipDeliveryDays / shipCostPerKg hold the SEA
  // (international) figures; surface* hold the domestic figures. calculateLogistics picks
  // the right pair from `region`. surface* fall back to ship* for legacy products.
  shipDeliveryDays: number;
  shipCostPerKg: number;
  surfaceDeliveryDays?: number;
  surfaceCostPerKg?: number;
  airCostPerKg: number;
  notes: string;
}

export type ShipRegion = 'IN' | 'US' | null | undefined;

// Resolve the SHIP lane's (days, cost) for a market. Domestic India uses the surface
// figures (falling back to the legacy ship values); everyone else uses sea/ship.
function shipLane(config: LogisticsConfig, region: ShipRegion): { days: number; costPerKg: number } {
  const isDomestic = region === 'IN';
  if (isDomestic) {
    return {
      days: config.surfaceDeliveryDays ?? config.shipDeliveryDays,
      costPerKg: config.surfaceCostPerKg ?? config.shipCostPerKg,
    };
  }
  return { days: config.shipDeliveryDays, costPerKg: config.shipCostPerKg };
}

export interface LogisticsCalculation {
  unitWeightKg: number;
  totalWeightKg: number;
  // null when the order weight falls outside every configured range for this market
  // (no fallback) — the shopper then picks the shipping method themselves.
  recommendedTransport: 'AIR' | 'SHIP' | null;
  selectedTransport: 'AIR' | 'SHIP' | null;
  deliveryDays: number;
  shippingCostPerKg: number;
  totalShippingCost: number;
  exceedsMaxWeight: boolean;
  maxWeightKg: number;
}

export function toKg(weight: number, uom: 'KG' | 'GRAM' | 'TON'): number {
  if (uom === 'GRAM') return weight / 1000;
  if (uom === 'TON') return weight * 1000;
  return weight;
}

export function calculateLogistics(
  config: LogisticsConfig,
  quantity: number,
  overrideTransport?: 'AIR' | 'SHIP',
  // Market the quote is for. Only affects the SHIP lane (SEA vs SURFACE cost/days).
  // Omitted → international (sea) figures, matching the pre-region behaviour.
  region?: ShipRegion
): LogisticsCalculation {
  const unitWeightKg = toKg(config.unitWeight, config.weightUom);
  const totalWeightKg = unitWeightKg * quantity;
  const maxWeightKg = toKg(config.maxWeight, config.weightUom);
  const exceedsMaxWeight = maxWeightKg > 0 && totalWeightKg > maxWeightKg;

  // Find recommended transport from weight ranges, region-aware. A range's
  // transport maps to the real AIR/SHIP mode, or null when it doesn't apply to this
  // market — so .in (Surface) and .com (Sea) can carry their own crossover weights.
  const isDomesticMkt = region === 'IN';
  const rangeModeForRegion = (t: string): 'AIR' | 'SHIP' | null => {
    const v = String(t || '').toUpperCase();
    if (v === 'AIR') return 'AIR';
    if (v === 'SURFACE') return isDomesticMkt ? 'SHIP' : null;
    if (v === 'SEA') return isDomesticMkt ? null : 'SHIP';
    if (v === 'SHIP') return 'SHIP';
    return null;
  };
  // No fallback: recommend a mode ONLY when the weight matches a range for this market.
  let recommendedTransport: 'AIR' | 'SHIP' | null = null;
  for (const range of config.weightRanges) {
    const mode = rangeModeForRegion(range.recommendedTransport);
    if (mode == null) continue;
    if (totalWeightKg >= range.minWeight && totalWeightKg <= range.maxWeight) {
      recommendedTransport = mode;
      break;
    }
  }

  // If only one transport type is available, it's the only option (not a fallback).
  if (config.transportTypes.length === 1) {
    recommendedTransport = config.transportTypes[0];
  }

  const selectedTransport: 'AIR' | 'SHIP' | null = overrideTransport && config.transportTypes.includes(overrideTransport)
    ? overrideTransport
    : recommendedTransport;

  const ship = shipLane(config, region);
  // No mode chosen yet → no quote (0 days / 0 cost) until the shopper selects one.
  const deliveryDays = selectedTransport === 'AIR'
    ? config.airDeliveryDays
    : selectedTransport === 'SHIP'
      ? ship.days
      : 0;

  const shippingCostPerKg = selectedTransport === 'AIR'
    ? config.airCostPerKg
    : selectedTransport === 'SHIP'
      ? ship.costPerKg
      : 0;

  const totalShippingCost = Math.round(totalWeightKg * shippingCostPerKg * 100) / 100;

  return {
    unitWeightKg,
    totalWeightKg,
    recommendedTransport,
    selectedTransport,
    deliveryDays,
    shippingCostPerKg,
    totalShippingCost,
    exceedsMaxWeight,
    maxWeightKg,
  };
}

export function formatWeight(kg: number): string {
  if (kg >= 1000) return `${(kg / 1000).toFixed(2)} TON`;
  if (kg < 1) return `${(kg * 1000).toFixed(0)} g`;
  return `${kg.toFixed(2)} KG`;
}

export function formatDimensions(dims: LogisticsConfig['dimensions']): string {
  if (!dims) return '';
  return `${dims.length} x ${dims.width} x ${dims.height} ${dims.unit}`;
}

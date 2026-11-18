import { toCsv } from '../csv.js';
import { mulberry32 } from '../engine/rng.js';

/** Entirely synthetic monthly data; no estimated causal effects or real merchants. */
export function demoDataset(seed = 42): string {
  const rng = mulberry32(seed);
  const rows: Record<string, unknown>[] = [];
  for (let sku = 1; sku <= 3; sku++) {
    for (let t = 0; t < 48; t++) {
      const season = 1 + 0.25 * Math.sin(2 * Math.PI * t / 12);
      const units = Math.round((70 + 25 * sku + t * sku) * season * (0.8 + 0.4 * rng()));
      const price = 400 + 100 * sku;
      const stock = Math.round(100 + rng() * 200);
      rows.push({ sku: `SYNTH-${sku}`, date: `${2021 + Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}-01`, units_sold: units, revenue: units * price, price, unit_cost: price * 0.6, stock, ad_spend: 2000, returns_units: Math.round(units * 0.03), lead_time_days: 5 + Math.round(rng() * 10), storage_cost: stock * 2 });
    }
  }
  return toCsv(Object.keys(rows[0]), rows);
}

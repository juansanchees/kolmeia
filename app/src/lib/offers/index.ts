import { buildingMaintenance } from "./building-maintenance";
import { hvacNewConstruction } from "./hvac-new-construction";
import type { Offer } from "./types";

export const OFFERS: Record<string, Offer> = { [hvacNewConstruction.id]: hvacNewConstruction, [buildingMaintenance.id]: buildingMaintenance };

export function getOffer(id: string): Offer {
  const o = Object.hasOwn(OFFERS, id) ? OFFERS[id] : undefined;
  if (!o) throw new Error(`unknown offer: ${id}`);
  return o;
}
export * from "./types";
export { toOpportunityRow, contactPath } from "./row";

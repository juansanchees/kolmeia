import "server-only";
import { envSchema } from "@/lib/env";

/** The only place that reads the Places key (a guard test pins this). Without it the Places step is off ("places_off"). */
export function getPlacesKey(): string | undefined {
  return envSchema.shape.GOOGLE_PLACES_API_KEY.parse(process.env.GOOGLE_PLACES_API_KEY);
}

export function hasPlaces(): boolean {
  return Boolean(getPlacesKey());
}

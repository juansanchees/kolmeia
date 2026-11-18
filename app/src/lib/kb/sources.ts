/** D8 source allowlist for the shared base (kb_*). Must match the SQL check in 0040_kb_base.sql (tests pin it). */
export const KB_SOURCES = ["maps_robot", "permit", "project", "crosswalk", "license_csl", "license_hic", "corp_registry", "site_robot"] as const;
export type KbSource = (typeof KB_SOURCES)[number];

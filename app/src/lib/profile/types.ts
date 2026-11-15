// F3c-3: the learned profile (K-7). Stored as jsonb in public.learned_profiles (migration 0015).
import type { CompanyType } from "@/lib/research/types";

export const POINT_KEYS = ["type", "size", "region", "projects", "signals", "where_to_find"] as const;
export type PointKey = (typeof POINT_KEYS)[number];

/** What the AI proposes and a sender approves. Every point cites rows of the training list. */
export type LearnedProfile = {
  /** At most 12; `text` up to 200 characters; `rows` are 1..20 import row numbers. */
  points: { key: PointKey; text: string; rows: number[] }[];
  /** The P5 filter (K-11): company type and town, both required when both are set. */
  filter: { companyTypes: CompanyType[]; towns: string[] };
  /** At most 8, up to 120 characters each; no social-network queries. */
  searchQueries: string[];
};

/** The snapshot a Caçador run carries (research_runs.profile_hints). */
export type ProfileHints = { version: number; lines: string[]; queries: string[] };

/** One row of a training list as the training call sees it (`row` = the import row number). */
export type TrainingRow = {
  row: number;
  name: string;
  city: string | null;
  state: string | null;
  website: string | null;
  contact_title: string | null;
  note: string | null;
};

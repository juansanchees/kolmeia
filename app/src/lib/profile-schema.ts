import { z } from "zod";

export const WANTED_WORK = ["new_construction", "multifamily", "commercial", "single_family", "maintenance"] as const;
export type WantedWork = (typeof WANTED_WORK)[number];

export const MAX_TEXT = 2000;

export const profileSchema = z.object({
  what_we_do: z.string().trim().min(1).max(MAX_TEXT),
  service_area: z.string().trim().min(1).max(MAX_TEXT),
  wanted_work: z.array(z.enum(WANTED_WORK)).max(WANTED_WORK.length),
  good_customer: z.string().trim().max(MAX_TEXT),
  not_wanted: z.string().trim().max(MAX_TEXT),
});

export type ProfileInput = z.infer<typeof profileSchema>;

export const workspaceNameSchema = z.string().trim().min(1).max(80);

export const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(200),
});

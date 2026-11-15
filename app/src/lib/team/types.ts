// Team vocabulary (migration 0020 part A). Safe for client and server.
import type { Role } from "@/lib/roles";

/** One member of the workspace, from list_workspace_people (owner/sdr only). */
export type Person = { user_id: string; role: Role; label: string };

/** An invite as the owner reads it: the token hash is never selectable. */
export type InviteRow = {
  id: string;
  name: string;
  email: string;
  role: "closer";
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export const INVITE_COLUMNS = "id, name, email, role, expires_at, accepted_at, revoked_at, created_at";

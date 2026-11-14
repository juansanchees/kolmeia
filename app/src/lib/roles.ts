// Client-safe role helpers (J2). Senders = the roles that may run agents and campaigns (matches is_workspace_sender() in the database).
export type Role = "owner" | "sdr" | "closer";

export function isSender(role: Role): boolean {
  return role === "owner" || role === "sdr";
}

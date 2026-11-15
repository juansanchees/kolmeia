// The professional social network the product never searches, reads, stores or shows (rules R11 and R15).
// Owner rule: its name never appears as a literal in src, so every string below is built from parts.

const NAME = ["linked", "in"].join("");

/** Main domain, built from parts. */
export const BLOCKED_NETWORK_DOMAIN = `${NAME}.com`;
/** Short-link domain. */
export const BLOCKED_NETWORK_SHORT = ["lnkd", "in"].join(".");
/** Host suffixes that are blocked (the host itself and any subdomain). */
export const BLOCKED_NETWORK_HOSTS: readonly string[] = [BLOCKED_NETWORK_DOMAIN, BLOCKED_NETWORK_SHORT];
/** Name, spaced, dotted or short-linked variants of the network, for free text such as search queries. */
export const BLOCKED_NETWORK_RE = /linked[\s_.-]*in|lnkd/i;

/** Model-facing name with its domains, built from the same parts; renders exactly as the old prompt text (no version bump). */
export const BLOCKED_NETWORK_PROMPT = `${["Linked", "In"].join("")} (${BLOCKED_NETWORK_DOMAIN}, ${BLOCKED_NETWORK_SHORT})`;

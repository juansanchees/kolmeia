// robots.txt (RFC 9309 subset): the group of our agent wins over "*", the longest matching rule wins, a tie allows,
// "*" and "$" work as wildcards. Pure.

export type RobotsRules = { allow: string[]; disallow: string[] };

const MAX_RULE_CHARS = 500;
const MAX_RULES = 500;
const MAX_PATH_CHARS = 2048;
const MAX_TEXT_CHARS = 512 * 1024;

/** Product token of a robots "User-agent" value or of our own agent string: "KolmeiaBot/1.0" -> "kolmeiabot". */
const productToken = (v: string) => v.split("/")[0].trim().toLowerCase();

export function parseRobots(text: string, agent: string): RobotsRules {
  const me = productToken(agent);
  type Group = { agents: string[]; allow: string[]; disallow: string[] };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let collecting = false; // still reading user-agent lines of the current group
  for (const raw of text.slice(0, MAX_TEXT_CHARS).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!cur || !collecting) {
        cur = { agents: [], allow: [], disallow: [] };
        groups.push(cur);
      }
      cur.agents.push(productToken(val));
      collecting = true;
    } else if (key === "allow" || key === "disallow") {
      collecting = false;
      if (!cur || !val || val.length > MAX_RULE_CHARS) continue; // an empty Disallow allows everything: no rule
      (key === "allow" ? cur.allow : cur.disallow).push(val);
    } else {
      collecting = false;
    }
  }
  const named = groups.filter((g) => g.agents.some((a) => a !== "*" && a === me));
  const chosen = named.length ? named : groups.filter((g) => g.agents.includes("*"));
  return { allow: chosen.flatMap((g) => g.allow).slice(0, MAX_RULES), disallow: chosen.flatMap((g) => g.disallow).slice(0, MAX_RULES) };
}

/** Prefix glob match ("*" any run, trailing "$" anchors the end). Literal segments are searched left to right, so the
 * cost is linear in practice and never backtracks exponentially. */
function globMatches(rawPattern: string, path: string): boolean {
  const anchored = rawPattern.endsWith("$");
  const segs = (anchored ? rawPattern.slice(0, -1) : rawPattern).replace(/\*+/g, "*").split("*");
  if (segs.length === 1) return anchored ? path === segs[0] : path.startsWith(segs[0]);
  if (!path.startsWith(segs[0])) return false;
  let pos = segs[0].length;
  for (let i = 1; i < segs.length - 1; i++) {
    const at = path.indexOf(segs[i], pos);
    if (at < 0) return false;
    pos = at + segs[i].length;
  }
  const last = segs[segs.length - 1];
  if (anchored) return path.length - last.length >= pos && path.endsWith(last);
  return last === "" || path.indexOf(last, pos) >= 0;
}

export function robotsAllows(rules: RobotsRules, rawPath: string): boolean {
  const path = rawPath.slice(0, MAX_PATH_CHARS);
  let best = -1;
  let allowed = true;
  for (const [list, isAllow] of [[rules.disallow, false], [rules.allow, true]] as const) {
    for (const p of list.slice(0, MAX_RULES)) {
      if (p.length > MAX_RULE_CHARS || !globMatches(p, path)) continue;
      const len = p.length;
      if (len > best || (len === best && isAllow)) {
        best = len;
        allowed = isAllow;
      }
    }
  }
  return allowed;
}

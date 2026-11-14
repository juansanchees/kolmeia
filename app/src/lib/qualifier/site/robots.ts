// robots.txt (RFC 9309 subset): the group of our agent wins over "*", the longest matching rule wins, a tie allows,
// "*" and "$" work as wildcards. Pure.

export type RobotsRules = { allow: string[]; disallow: string[] };

export function parseRobots(text: string, agent: string): RobotsRules {
  const me = agent.toLowerCase();
  type Group = { agents: string[]; allow: string[]; disallow: string[] };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let collecting = false; // still reading user-agent lines of the current group
  for (const raw of text.split(/\r?\n/)) {
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
      cur.agents.push(val.toLowerCase());
      collecting = true;
    } else if (key === "allow" || key === "disallow") {
      collecting = false;
      if (!cur || !val) continue; // an empty Disallow allows everything: no rule
      (key === "allow" ? cur.allow : cur.disallow).push(val);
    } else {
      collecting = false;
    }
  }
  const named = groups.filter((g) => g.agents.some((a) => a !== "*" && a !== "" && me.includes(a)));
  const chosen = named.length ? named : groups.filter((g) => g.agents.includes("*"));
  return { allow: chosen.flatMap((g) => g.allow), disallow: chosen.flatMap((g) => g.disallow) };
}

function toRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function robotsAllows(rules: RobotsRules, path: string): boolean {
  let best = -1;
  let allowed = true;
  for (const [list, isAllow] of [[rules.disallow, false], [rules.allow, true]] as const) {
    for (const p of list) {
      if (!toRegex(p).test(path)) continue;
      const len = p.length;
      if (len > best || (len === best && isAllow)) {
        best = len;
        allowed = isAllow;
      }
    }
  }
  return allowed;
}

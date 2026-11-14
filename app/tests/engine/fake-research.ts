import type { AiRequest } from "@/lib/ai/types";
import { FakeTransport, USAGE } from "./fake-ai";

// Fixtures of the research engine tests (moved verbatim from engine.test.ts so the hunter tests share them).

export const refsIn = (req: AiRequest) => [...req.user.matchAll(/"ref":\s*"([0-9a-f-]{36})"/g)].map((m) => m[1]);
export const namesIn = (req: AiRequest) => [...req.user.matchAll(/"name":\s*"([^"]+)"/g)].map((m) => m[1]);

export const MARK_SUMMARY = "FIRST_PASS_CONCLUSION_7f3";
export const MARK_HOOK = "Who is doing the HVAC at 12 Main St";

export const questionsJson = {
  understood: "Entendi: construtores pequenos e ativos.",
  places: ["Worcester County, MA", "Framingham, MA"],
  questions: [
    { id: "size", text: "O que é pequeno?", options: ["Até 5 obras", "Até 10 obras", "Até 20 obras"], allow_free_text: true },
    { id: "job", text: "Que tipo de obra?", options: ["Obra nova", "Reforma grande"], allow_free_text: false },
  ],
};

export const planJson = {
  summary: "Construtores pequenos ativos em Worcester County.",
  places: ["Worcester County, MA", "Framingham, MA"],
  source_types: ["Portais de alvarás", "Registro de empresas de MA", "Associações"],
  warnings: ["Algumas cidades não publicam alvarás online."],
};

export const discoverJson = {
  sources: [
    { kind: "permits", title: "Worcester permits", url: "https://permits.worcester.example/search", status: "used", note: "mostra o requerente" },
    { kind: "permits", title: "Barnstable permits", url: "https://barnstable.example/permits", status: "blocked", note: "ligar para o Building Division" },
    { kind: "news", title: "Local news", url: "https://news.example", status: "empty", note: "nada recente" },
    { kind: "other", title: "LinkedIn search", url: "https://www.linkedin.com/search/results", status: "used", note: "" },
  ],
};

export const collectJson = (n: number) => ({
  candidates:
    n === 0
      ? [
          cand("Acme Builders, Inc.", "https://acmebuilders.example", "(508) 555-0101"),
          cand("Beta Homes LLC", "https://betahomes.example", "508-555-0102"),
          cand("Gamma Construction", "https://gamma.example", "508 555 0103"),
          cand("ACME BUILDERS", "https://acme-other.example", "508-555-0199"), // same name: merged
          cand("Delta Co", "https://delta.example", "+1 508 555 0102"), // same phone as Beta: merged
        ]
      : [],
  jobs_without_builder:
    n === 0
      ? [
          { address: "40 Elm St, Worcester MA", project_name: "", job_type: "New 3-family", declared_value_usd: "650000", date: "2026-10-02", url: "https://permits.worcester.example/p/40-elm", excerpt: "Owner: Elm Trust; contractor: (blank)" },
          { address: "", project_name: "", job_type: "?", declared_value_usd: "", date: "", url: "https://permits.worcester.example/p/x", excerpt: "no address" },
        ]
      : [],
  sources_tried: [{ url: "https://permits.worcester.example/search", title: "Worcester permits", status: "used", note: "" }],
  exhausted: true,
});

export function cand(name: string, website: string, phone: string) {
  return {
    name,
    city: "Worcester",
    state: "MA",
    region: "Central MA",
    website,
    phone,
    phone_source_url: website,
    company_type: "builder",
    size_note: "",
    entry_path: name.startsWith("Acme") ? "signal" : "directory",
    found_at: { url: "https://permits.worcester.example/search", title: "Worcester permits", excerpt: `${name} applicant` },
  };
}

export const ev2 = (tag: string) => [
  { url: `https://permits.worcester.example/${tag}`, title: "Permit", excerpt: "Permit issued 2026-10-20" },
  { url: `https://news.example/${tag}`, title: "News", excerpt: "Company announced new homes" },
];

export function verifyJson(req: AiRequest) {
  const refs = refsIn(req);
  const names = namesIn(req);
  return {
    companies: refs.map((ref, i) => {
      const name = names[i] ?? "";
      const big = name.startsWith("Acme");
      const weak = name.startsWith("Gamma");
      return {
        ref,
        urls_tried: [],
        checks: [
          { kind: "exists_active", result: "ok", summary: `${MARK_SUMMARY} ativa`, evidence: ev2(`e${i}`) },
          // Gamma: only one host -> must become "unknown" in strict (P9)
          { kind: "has_work", result: "ok", summary: `${MARK_SUMMARY} obra`, evidence: weak ? [ev2(`w${i}`)[0]] : ev2(`w${i}`) },
          { kind: "fits_profile", result: "ok", summary: "perfil", evidence: ev2(`f${i}`) },
          big
            ? {
                kind: "decision_maker",
                result: "ok",
                summary: "dono",
                evidence: [
                  { url: "https://acmebuilders.example/about", title: "About", excerpt: "Owner listed on the about page" },
                  { url: "https://permits.worcester.example/acme-applicant", title: "Permit", excerpt: "Applicant listed" },
                ],
              }
            : { kind: "decision_maker", result: "unknown", summary: "sem nome", evidence: [] },
        ],
        permit_count: "3",
        total_value_usd: big ? "$1,200,000" : "300000",
        last_permit_date: "2026-08-01",
        biggest_job_address: "12 Main St, Worcester MA",
        biggest_job_value_usd: big ? "900000" : "150000",
        biggest_job_type: "RESI",
        biggest_job_description: "New 2-story home",
        signal_match: "Worcester permits (match: name)",
        ask_for_name: big ? "Ann Acme" : "",
        ask_for_title: big ? "Owner" : "",
        name_confidence: big ? "high" : "none",
        name_source_url: big ? "https://acmebuilders.example/about" : "",
        name_note: "",
        phone: "",
        phone_source_url: "",
        website: "",
        public_email: big ? "ann@acmebuilders.example" : "",
        email_type: big ? "named" : "none",
        email_source_url: big ? "https://acmebuilders.example/contact" : "",
        google_rating: "4.6",
        review_count: "12",
        rating_source_url: "https://maps.example/place",
        is_large_contractor: false,
        supplier_portal_url: "",
        hook: `Saw your permit - ${MARK_HOOK} (~$900k)?`,
        notes: "",
      };
    }),
    jobs_without_builder: [],
  };
}

export function secondJson(req: AiRequest) {
  const refs = refsIn(req);
  const names = namesIn(req);
  return {
    companies: refs.map((ref, i) =>
      names[i]?.startsWith("Beta")
        ? {
            ref,
            urls_tried: [],
            verdict: "refuted",
            checks: [
              {
                kind: "exists_active",
                result: "no",
                summary: "Entidade dissolvida em 2025.",
                evidence: [{ url: "https://corp.sec.state.ma.example/beta", title: "MA SOC", excerpt: "Status: Dissolved" }],
              },
            ],
          }
        : { ref, urls_tried: [], verdict: "stands", checks: [{ kind: "exists_active", result: "ok", summary: "confirmada", evidence: ev2(`s${i}`) }] },
    ),
  };
}

export function happyTransport() {
  return new FakeTransport({
    research_questions: () => ({ json: questionsJson }),
    research_plan: () => ({ json: planJson }),
    research_discover: () => ({ json: discoverJson, usage: { ...USAGE, webSearches: 4 } }),
    research_collect: (_r, n) => ({ json: collectJson(n), usage: { ...USAGE, webSearches: 3, webFetches: 2 } }),
    research_verify: (r) => ({ json: verifyJson(r), usage: { ...USAGE, webSearches: 2 } }),
    research_second_pass: (r) => ({ json: secondJson(r) }),
  });
}


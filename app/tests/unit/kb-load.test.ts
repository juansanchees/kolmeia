import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { KB_SOURCES } from "@/lib/kb/sources";
import { companiesItems, crosswalkItems, falmouthPermitItems, licenseItems, mapsItems, massbuildsProjectItems, permitItems, projectItems } from "@/lib/kb/load";
import { nameKey } from "@/lib/research/dedupe";

const SEEN = "2026-11-18T00:00:00Z";
const MAPS_H = "name,phone,emails,website,category,address,city,state,zip,rating,reviews,place_id,lat,lon,searched_towns";

describe("mapsItems", () => {
  test("maps keeps only builder categories", () => {
    const r = mapsItems(`${MAPS_H}\nAcme Builders LLC,555-0100,,https://example.com,General contractor,1 Example Rd,Exampleton,Massachusetts,01000,,,pid1,,,\nRoof Co,555-0101,,,Roofing contractor,,Exampleton,Massachusetts,,,,pid2,,,\n`, SEEN);
    expect(r.items).toHaveLength(1);
    expect(r.skipped.category).toBe(1);
  });
  test("maps state normalised", () => {
    const r = mapsItems(`${MAPS_H}\nAcme Builders LLC,555-0100,,,General contractor,,Exampleton,Massachusetts,,,,pid1,,,\n`, SEEN);
    expect(r.items[0].company?.state).toBe("MA");
    expect(r.items[0].values?.[0].source_url).toBe("https://www.google.com/maps/place/?q=place_id:pid1");
  });
});

describe("companiesItems", () => {
  test("individual skipped", () => {
    const h = "company,looks_like_individual,mapped_from_person,license,variants";
    const r = companiesItems(`${h}\nJane Q Example,1,0,,\nJohn Q Example,1,1,CS-1,\nAcme Builders LLC,0,0,CS-2,\n`, SEEN);
    expect(r.skipped.individual).toBe(1);
    expect(r.items.map((i) => i.company?.name)).toEqual(["John Q Example", "Acme Builders LLC"]);
    expect(r.items[0].company?.city).toBeUndefined();
  });
});

describe("permitItems", () => {
  const h = "source,town,permit_id,issued_date,address,declared_value_usd,permit_type,work_class,use,description,contractor_name,contractor_phone,contractor_license,applicant_name,owner_name,units,sqft,source_url";
  const variants = new Map([[nameKey("ACME BLDRS"), "Acme Builders LLC"]]);
  test("permit links by variant; owner/applicant never mapped; junk and unknown skipped", () => {
    const csv = `${h}\nboston_ckan,Exampleton,A1,2026-03-04,12 Example Rd,500000,x,New,res,new house,ACME BLDRS,555-0100,,Pat Applicant,Olive Owner,,,\nboston_ckan,Exampleton,A2,2026-03-04,13 Example Rd,1,x,x,x,x,HOMEOWNER,,,,,,,\nboston_ckan,Exampleton,A3,2026-03-04,14 Example Rd,1,x,x,x,x,TOWN OF EXAMPLETON,,,,,,,\nboston_ckan,Exampleton,A4,2026-03-04,15 Example Rd,1,x,x,x,x,Other Co,,,,,,,\n`;
    const r = permitItems(csv, variants);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].match_only).toBe(true);
    expect(r.items[0].company?.name).toBe("Acme Builders LLC");
    expect(r.items[0].signals?.[0]).toMatchObject({ kind: "permit", source: "permit", source_ref: "boston_ckan:A1", value_usd: 500000, issued_on: "2026-03-04" });
    expect(JSON.stringify(r.items)).not.toMatch(/Olive|Pat Applicant/);
    expect(r.skipped).toEqual({ junk: 2, unknown_contractor: 1 });
  });
});

describe("projectItems and massbuilds", () => {
  const h = "source,project_name,town,address,project_type,status,units,sqft,value_usd,developer,general_contractor,architect,other_parties,key_date,description,source_url";
  test("one item per gc and developer", () => {
    const r = projectItems(`${h}\nmassbuilds,Example Flats,Exampleton,1 Example Rd,new,open,24,,3000000,Dev Homes LLC,Acme Builders LLC,,,2026-01-05,,https://example.com/p\n`, SEEN);
    expect(r.items.map((i) => i.company?.company_type)).toEqual(["gc", "developer"]);
    expect(r.items[0].signals?.[0].description).toBe("24 units");
    expect(r.items[0].signals?.[0].source_ref.length).toBeLessThanOrEqual(120);
  });
  test("massbuildsProjectItems keeps one town and company-less projects", () => {
    const r = massbuildsProjectItems(`${h}\nmassbuilds,A,Exampleton,1 Example Rd,new,open,,,,,,,,,,\nmassbuilds,B,Elsewhere,2 Example Rd,new,open,,,,,Acme Builders LLC,,,,,\n`, "exampleton");
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ match_only: true });
    expect(r.items[0].company).toBeUndefined();
    expect(r.skipped.other_town).toBe(1);
  });
});

describe("falmouthPermitItems", () => {
  const h = "source,permit_no,issued_on,address,town,work_class,use,value_usd,description,applicant_name,applicant_phone,contractor_name,source_url";
  test("applicant phone is memo only, never in items", () => {
    const r = falmouthPermitItems(`${h}\nexample_town,P-1,2026-03-04,12 Example Rd,Exampleton,New,Residential,400000,new house,Pat Person,(508) 555-0123,Acme Builders LLC,https://example.com/p1\n`);
    expect(JSON.stringify(r.items)).not.toMatch(/0123|Pat Person/);
    expect(r.memo["example_town:P-1"]).toEqual({ applicantName: "Pat Person", applicantPhone: "(508) 555-0123" });
    expect(r.items[0].signals?.[0].permit_no).toBe("P-1");
  });
  test("blank contractor keeps the permit with no company; company-like applicant stands in; person applicant is not stored", () => {
    const r = falmouthPermitItems(`${h}\nt,P-2,2026-03-04,1 Example Rd,Exampleton,New,,,,Pat Person,,,\nt,P-3,2026-03-04,2 Example Rd,Exampleton,New,,,,Zed Homes LLC,,,\nt,P-4,2026-03-04,3 Example Rd,Exampleton,New,,,,x,,HOMEOWNER,\n`);
    expect(r.items[0].company).toBeUndefined();
    expect(r.items[0].signals?.[0].applicant_name).toBeUndefined();
    expect(r.items[1].company?.name).toBe("Zed Homes LLC");
    expect(r.items[2].company).toBeUndefined();
    expect(r.unlinked).toBe(2);
  });
});

describe("crosswalkItems", () => {
  test("crosswalk keeps unambiguous only", () => {
    const h = "person_norm_key,person_display,firm,firm_norm_key,n_pairs,n_person_firm_rows_total,share,last_seen_date,sources,license_number,status";
    const r = crosswalkItems(`${h}\nx,Pat Example,Acme Builders LLC,,,,,,,CS-9,unambiguous\ny,Sam Example,Acme Builders LLC,,,,,,,CS-8,ambiguous\n`, SEEN);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].match_only).toBe(true);
    expect(r.items[0].people?.[0]).toMatchObject({ name: "Pat Example", license: "CS-9", source: "crosswalk" });
  });
});

describe("licenseItems", () => {
  const h = "source,license_type,license_number,name,firm,city,state,status,issued_date,expires_date,source_url,address";
  test("license row has no address", () => {
    const r = licenseItems(`${h}\nlicense_csl,CSL,CS-1,Pat Example,Acme Builders LLC,Exampleton,MA,active,,,https://example.com/l,99 Home Street\n`, SEEN);
    expect(JSON.stringify(r.items)).not.toMatch(/Home Street/);
    expect(r.items[0].people?.[0].license).toBe("CS-1");
  });
  test("license without firm skipped; unknown source throws", () => {
    expect(licenseItems(`${h}\nlicense_hic,HIC,H-1,Pat Example,,Exampleton,MA,active,,,,\n`, SEEN).skipped.individual).toBe(1);
    expect(() => licenseItems(`${h}\napollo,HIC,H-1,Pat,Acme Builders LLC,,MA,active,,,,\n`, SEEN)).toThrow(/source not allowed/);
  });
});

describe("source allowlist", () => {
  test("every kb_* `source in (...)` check in 0040 is exactly KB_SOURCES", () => {
    const sql = readFileSync(new URL("../../supabase/migrations/0040_kb_base.sql", import.meta.url), "utf8");
    const lists = [...sql.matchAll(/source[^\n]*check \(source in \(([^)]*)\)\)/g)].map((m) => [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]));
    expect(lists.length).toBe(3);
    for (const l of lists) expect(l).toEqual([...KB_SOURCES]);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TestDb, anon } from "./helpers";

// Migration 0038: the public waitlist (PGlite, real migrations, fictional e-mails).

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create();
});
afterAll(async () => {
  await db.pg.close();
});

describe("0038 waitlist", () => {
  test("anon joins through the RPC; a repeat in another case is a silent no-op that returns nothing", async () => {
    const first = await db.query(anon, "select public.join_waitlist($1, 'en') as r", ["  Fulano@Exemplo.com "]);
    const again = await db.query(anon, "select public.join_waitlist($1, 'pt') as r", ["fulano@exemplo.COM"]);
    expect(again).toEqual(first);
    expect(await db.admin("select email, locale from public.waitlist")).toEqual([{ email: "fulano@exemplo.com", locale: "en" }]);
  });
  test("bad e-mails and unknown locales: bad e-mail is refused, unknown locale becomes pt", async () => {
    for (const bad of ["", "sem-arroba", "a@b", "a b@exemplo.com", "x@exemplo..com", `${"a".repeat(250)}@exemplo.com`]) {
      expect((await db.try(anon, "select public.join_waitlist($1, 'pt')", [bad])).error, bad).toBeDefined();
    }
    await db.query(anon, "select public.join_waitlist('outro@exemplo.com', 'fr')");
    expect(await db.admin("select locale from public.waitlist where email = 'outro@exemplo.com'")).toEqual([{ locale: "pt" }]);
  });
  test("clients cannot read or write the table directly", async () => {
    expect((await db.try(anon, "select * from public.waitlist")).error).toBeDefined();
    expect((await db.try(anon, "insert into public.waitlist (email) values ('x@exemplo.com')")).error).toBeDefined();
  });
});

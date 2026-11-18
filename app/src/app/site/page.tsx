import type { Metadata } from "next";
import Link from "next/link";
import { KolmeiaMark } from "@/components/Logo";
import { getLocale, getT } from "@/lib/i18n/server";
import { LandingFx } from "./LandingFx";
import { LandingLocale } from "./LandingLocale";
import { WaitlistForm } from "./WaitlistForm";
import { landingFonts } from "./fonts";
import "./landing.css";

export async function generateMetadata(): Promise<Metadata> {
  const { landing } = await getT();
  const locale = await getLocale();
  return {
    title: landing.meta.title,
    description: landing.meta.description,
    metadataBase: new URL("https://kolmeia.solutions"),
    alternates: { canonical: "/" },
    robots: { index: true, follow: true },
    openGraph: { title: landing.meta.title, description: landing.meta.description, type: "website", siteName: "Kolmeia", url: "/", locale: locale === "en" ? "en_US" : "pt_BR" },
    twitter: { card: "summary", title: landing.meta.title, description: landing.meta.description },
  };
}

export default async function LandingPage() {
  const { landing: t } = await getT();
  return (
    <div className={`lp ${landingFonts}`}>
      <nav className="nav" aria-label={t.nav.label}>
        <div className="wrap">
          <a className="logo" href="#topo" aria-label={t.nav.home}>
            <KolmeiaMark size={34} />
            Kolmeia
          </a>
          <div className="nav-links">
            <a href="#como">{t.nav.how}</a>
            <a href="#recursos">{t.nav.features}</a>
            <a href="#comparar">{t.nav.compare}</a>
            <a href="#faq">{t.nav.faq}</a>
          </div>
          <div className="nav-tools">
            <LandingLocale />
            <Link className="nav-login" href="/login">
              {t.nav.login}
            </Link>
          </div>
          <a className="btn btn-honey" href="#lista">
            {t.nav.waitlist}
          </a>
        </div>
      </nav>

      <main id="topo">
        <section className="hero">
          <div className="wrap">
            <div className="hero-copy">
              <span className="eyebrow">{t.hero.eyebrow}</span>
              <h1>
                {t.hero.h1Lead}
                <span className="mark">{t.hero.h1Mark}</span>
              </h1>
              <p className="lede">{t.hero.lede}</p>
              <div className="cta-row">
                <a className="btn btn-honey" href="#lista">
                  {t.hero.cta}
                </a>
                <a className="btn btn-ghost" href="#como">
                  {t.hero.secondary}
                </a>
              </div>
              <p className="hero-note">
                <span>{t.hero.note1}</span>
                <span>{t.hero.note2}</span>
              </p>
            </div>
            <div className="holo" aria-hidden="true">
              <canvas />
              {t.hero.cards.map((c) => (
                <div className="co" key={c.name}>
                  <span className="k">{t.hero.cardKind}</span>
                  <b>{c.name}</b>
                  <span>{c.role}</span>
                  <span className="t">(000) 000-0000</span>
                  <span className="c">
                    {c.chips.map((chip) => (
                      <i key={chip}>{chip}</i>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="problem">
          <div className="wrap">
            <div className="head reveal">
              <span className="eyebrow">{t.problem.eyebrow}</span>
              <h2>{t.problem.title}</h2>
              <p className="lede">{t.problem.lede}</p>
            </div>
            <div className="pains">
              {t.problem.pains.map((p) => (
                <article className="pain reveal" key={p.title}>
                  <span className="big">{p.title}</span>
                  <p>{p.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="como">
          <div className="wrap">
            <div className="head reveal">
              <span className="eyebrow">{t.how.eyebrow}</span>
              <h2>{t.how.title}</h2>
            </div>
            <ol className="steps" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {t.how.steps.map((s, i) => (
                <li className="step reveal" key={s.title}>
                  <span className="n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="show" aria-labelledby="show-h">
          <div className="wrap">
            <div className="show-copy reveal">
              <span className="eyebrow">{t.show.eyebrow}</span>
              <h2 id="show-h">{t.show.title}</h2>
              <p className="lede">{t.show.lede}</p>
              <ul>
                {t.show.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
            <div className="panels" role="img" aria-label={t.show.imageAlt}>
              <div className="pstage">
                <div className="panel panel-camp">
                  <div className="ph">
                    {t.show.camp.title} <small>{t.show.example}</small>
                  </div>
                  {t.show.camp.rows.map((r, i) => (
                    <div className="row" key={r.title}>
                      <div>
                        <div className="t">{r.title}</div>
                        <div className="s">{r.sub}</div>
                      </div>
                      <span className={i === 0 ? "pill" : "pill soft"}>{r.pill}</span>
                    </div>
                  ))}
                </div>
                <div className="panel panel-queue">
                  <div className="ph">
                    {t.show.queue.title} <small>{t.show.example}</small>
                  </div>
                  {t.show.queue.rows.map((r, i) => (
                    <div className="row" key={r.title}>
                      <div>
                        <div className="t">{r.title}</div>
                        <div className="s">{r.sub}</div>
                      </div>
                      <span className={i === 0 ? "pill" : "pill soft"}>{r.pill}</span>
                    </div>
                  ))}
                  <div className="onebtn">
                    <span className="fake-btn">{t.show.queue.log}</span>
                    <span className="fake-btn alt">{t.show.queue.call}</span>
                  </div>
                </div>
                <div className="panel panel-lead">
                  <div className="ph">
                    {t.show.lead.title} <span className="pill ok">{t.show.lead.badge}</span>
                  </div>
                  <dl className="kv">
                    <dt>{t.show.lead.decider}</dt>
                    <dd>{t.show.lead.deciderValue}</dd>
                    <dt>{t.show.lead.company}</dt>
                    <dd>{t.show.lead.companyValue}</dd>
                    <dt>{t.show.lead.phone}</dt>
                    <dd>
                      (000) 000-0000 <span className="chip src">{t.show.lead.phoneSource}</span>
                    </dd>
                    <dt>{t.show.lead.email}</dt>
                    <dd>
                      maria@exemplo.com <span className="chip">{t.show.lead.emailChip}</span>
                    </dd>
                  </dl>
                  <div className="hook">
                    <b>{t.show.lead.hookLabel}</b>
                    {t.show.lead.hook}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="features" id="recursos">
          <div className="wrap">
            <div className="head reveal">
              <span className="eyebrow">{t.features.eyebrow}</span>
              <h2>{t.features.title}</h2>
              <p className="lede">{t.features.lede}</p>
            </div>
            <div className="fgrid">
              <article className="feat wide reveal" style={{ "--i": 0 } as React.CSSProperties}>
                <div className="fp">
                  <div className="fh" aria-hidden="true">
                    <canvas data-holo="proof" />
                  </div>
                  <div className="ftxt">
                    <h3>{t.features.proof.title}</h3>
                    <p>{t.features.proof.body}</p>
                    <div className="proof" aria-label={t.features.proof.label}>
                      <div>
                        <small>{t.features.proof.decider}</small>
                        {t.features.proof.deciderValue}
                      </div>
                      <div>
                        <small>{t.features.proof.hookSource}</small>
                        {t.features.proof.hookSourceValue}
                      </div>
                      <div>
                        <small>{t.features.proof.phone}</small>
                        (000) 000-0000
                      </div>
                      <div>
                        <small>{t.features.proof.email}</small>
                        {t.features.proof.emailValue}
                      </div>
                    </div>
                  </div>
                </div>
              </article>
              <Feature i={1} holo="radar" title={t.features.hunter.title} body={t.features.hunter.body} />
              <Feature i={2} holo="gauge" title={t.features.qualifier.title} body={t.features.qualifier.body} />
              <Feature i={3} holo="queue" title={t.features.queue.title} body={t.features.queue.body} cls="drop" />
              <Feature i={4} holo="camp" title={t.features.campaigns.title} body={t.features.campaigns.body} tag={t.features.campaigns.tag} />
              <Feature i={5} holo="team" title={t.features.team.title} body={t.features.team.body} cls="xl" />
              <Feature i={6} holo="lang" title={t.features.lang.title} body={t.features.lang.body} cls="drop" />
            </div>
          </div>
        </section>

        <section id="comparar">
          <div className="wrap">
            <div className="head reveal">
              <span className="eyebrow">{t.compare.eyebrow}</span>
              <h2>{t.compare.title}</h2>
              <p className="lede">{t.compare.lede}</p>
            </div>
            <div className="cmp-box reveal">
              <table className="cmp">
                <thead>
                  <tr>
                    <th scope="col">{t.compare.colPoint}</th>
                    <th scope="col">{t.compare.colThem}</th>
                    <th scope="col" className="us">
                      {t.compare.colUs}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {t.compare.rows.map((r) => (
                    <tr key={r.point}>
                      <th scope="row">{r.point}</th>
                      <td className="them" data-label={t.compare.colThem}>
                        {r.them}
                      </td>
                      <td className="us" data-label={t.compare.colUs}>
                        {r.us}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="cmp-note">{t.compare.note}</p>
          </div>
        </section>

        <section style={{ paddingTop: 0 }}>
          <div className="wrap">
            <div className="head reveal">
              <span className="eyebrow">{t.who.eyebrow}</span>
              <h2>{t.who.title}</h2>
            </div>
            <div className="who">
              {t.who.cards.map((c, i) => (
                <article className={i === 0 ? "who-card hl reveal" : "who-card reveal"} key={c.title}>
                  <span className="hexdot" aria-hidden="true" />
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="wl" id="lista">
          <div className="wrap">
            <div className="wl-card reveal">
              <div className="wl-copy">
                <span className="eyebrow" style={{ color: "#C9CEDD" }}>
                  {t.waitlist.eyebrow}
                </span>
                <h2>{t.waitlist.title}</h2>
                <p className="lede">{t.waitlist.lede}</p>
              </div>
              <WaitlistForm />
            </div>
          </div>
        </section>

        <section id="faq" style={{ paddingTop: 0 }}>
          <div className="wrap">
            <div className="head reveal">
              <span className="eyebrow">{t.faq.eyebrow}</span>
              <h2>{t.faq.title}</h2>
            </div>
            <div className="faq">
              {t.faq.items.map((f) => (
                <details className="reveal" key={f.q}>
                  <summary>{f.q}</summary>
                  <p className="a">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="final" style={{ paddingTop: 0 }}>
          <div className="wrap reveal">
            <h2>{t.final.title}</h2>
            <a className="btn btn-honey" href="#lista">
              {t.final.cta}
            </a>
          </div>
        </section>
      </main>

      <footer>
        <div className="wrap">
          <span className="logo" style={{ fontSize: 17 }}>
            <KolmeiaMark size={26} />
            Kolmeia
          </span>
          <span className="foot-links">
            <span>{t.footer.note}</span>
            <Link href="/login">{t.nav.login}</Link>
          </span>
        </div>
      </footer>

      <LandingFx labels={t.holo} />
    </div>
  );
}

function Feature({ i, holo, title, body, tag, cls }: { i: number; holo: string; title: string; body: string; tag?: string; cls?: string }) {
  return (
    <article className={`feat ${cls ? cls + " " : ""}reveal`} style={{ "--i": i } as React.CSSProperties}>
      <div className="fp">
        <div className="fh" aria-hidden="true">
          <canvas data-holo={holo} />
        </div>
        <div className="ftxt">
          <h3>{title}</h3>
          <p>{body}</p>
          {tag ? <span className="tag">{tag}</span> : null}
        </div>
      </div>
    </article>
  );
}

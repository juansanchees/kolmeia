# F3d: Fontes conectadas (Apify Maps, Apollo, Apify Contatos)

Data: 14/11/2026. Status: **Aprovado pelo Juan (14/11/2026)**.
Depende de: F3b (tick), F3c-1 (migração 0011: `lead_imports`, `lead_fields`, `find_lead`, `import_lead_rows`). A parte F3d-2 (contatos) depende da F3c-2 (0012: Qualificador, leitor P2, Gastos).
Convenção: "(Juan)" decidido por ele; "(Claude — conferir)" Claude decidiu; "?" não verificado.

## 1. Ideia em 1 linha
Cada workspace liga **as próprias contas** (traz a própria chave). O Kolmeia nunca revende dado do Apollo nem do Google Maps em nome dele. (Juan)

## 2. Decisões

| # | Decisão | Quem |
|---|---|---|
| S-1 | ⚙ Configurações › **Fontes conectadas**: Apify [chave] + teto diário US$; Apollo [chave] + teto de buscas/dia. Só o dono liga/desliga; sdr vê o status; closer não vê | Juan / Claude — conferir (papéis) |
| S-2 | Chaves cifradas em repouso com o mesmo AES-256-GCM das caixas (`src/lib/email/crypto.ts`, `MAILBOX_ENC_KEY`), AAD `source:{workspace}:{provider}`. Nunca em log, erro, resposta ou URL; tela mostra só `••••1234` | Juan |
| S-3 | Ao salvar, a chave é testada (Apify `GET /v2/users/me`; Apollo: 1 busca grátis com `per_page 1` ?). Falhou → não salva, mensagem curta | Claude — conferir |
| S-4 | Resultado de fonte entra **pelo caminho do import da F3c-1**: um `lead_imports` com `kind` (`apify_maps` / `apollo`), mesma deduplicação (`find_lead`), mesmo "Desfazer", cada valor em `lead_fields` com `source` = `apify_maps` / `apollo` e `seen_at` = data | Juan |
| S-5 | Toda chamada externa é uma linha em `source_runs` (o "livro" das fontes): reserva antes, custo real depois, dia em America/New_York. Teto por workspace; sem chave = não roda | Juan |
| S-6 | Execução só no tick da F3b (`runSourceTick`, depois do Caçador e do Qualificador): iniciar, consultar por `run id`, baixar itens, importar. A tela só põe na fila | Claude — conferir |
| S-7 | LinkedIn nunca: qualquer URL LinkedIn é descartada (`sanitizeUrl` já recusa) | Juan |
| S-8 | Testes nunca tocam a rede: HTTP falso em tudo | Juan |

## 3. As 3 fontes

| Fonte | Ator / endpoint | Onde entra | Custo |
|---|---|---|---|
| Apify Google Maps | `compass/crawler-google-places` | Caçador (busca extra por agente) + botão manual **"Buscar no Maps"** em LEADS | ~US$ 0,004/lugar (?) |
| Apollo | busca grátis de organizações (`display_mode fuzzy_select_mode`; filtros `organization_locations` + `organization_naics_codes`, ex.: `236`) | Botão manual **"Buscar no Apollo"** + Caçador | grátis (?); conta em buscas/dia |
| Apify Contatos | `vdrmota/contact-info-scraper` | Qualificador, passo **P2b**, só quando o leitor grátis (P2) não achou e-mail | ~US$ 0,002/página + proxy (?) |

**Maps — entrada fixa:** `searchStringsArray`, `locationQuery`, `maxCrawledPlacesPerSearch` = ceil(máx / nº de termos), `language "en"`, `skipClosedPlaces true`, `scrapePlaceDetailPage false`, `scrapeContacts false`. Toda execução passa `maxTotalChargeUsd` = max(0,50, máx × 0,004 arredondado para cima no centavo) (mínimo do Apify: 0,50) e `timeout 600`. Máx por busca: 200 lugares (Claude — conferir).
Mapeamento: `title`→name, `phone`, `website`, `street`/`address`, `city`, `state`, `postalCode`→zip, `placeId`→place_id, `categoryName`→company_type. Descarta `countryCode ≠ US`, `permanentlyClosed`, sem nome.
Medido 14/11 (Worcester "general contractor"): melhor lista (Cutler, BB&R, Antonelli), 20/20 telefones, ~40% de ruído de categoria. O ruído fica para o Qualificador/perfil; aqui não filtra categoria.

**Apollo — regras:** só o endpoint grátis (`mixed_companies` completo é bloqueado no plano Free). Devolve id, name, domain, website_url, sem telefone. Descarta (~20% medido): domínio com TLD de país ≠ `.us` (`.co.uk`, `.com.pk`, `.ca`…), sem domínio e sem site. Caminho REST e campos de resposta: "?" até testar com a chave do Juan (o plano tem o passo).

**Contatos (F3d-2):** `startUrls` = site do lead, `maxRequestsPerStartUrl 5`, `maxDepth 1`, `sameDomain true`, `mergeContacts true`, `proxyConfig { useApifyProxy: true }`, `maxTotalChargeUsd 0.50`. Até 10 leads por execução (divide o mínimo de 0,50). Guarda **só e-mails**, e só se: o domínio do e-mail = domínio do lead, OU o item veio de uma página do próprio site (host igual). Descarta `example.*`, extensões de imagem, `wixpress.com`, `sentry.*`, `domain.com`. Fonte `apify_contact`, status `confirmed` (está no site), com a URL.

## 4. Caçador
Tabela própria `agent_source_settings` (não mexe na config congelada do agente, A6): por agente, Maps (termos, local, máx) e Apollo (local, NAICS, páginas), cada um liga/desliga. Quando o Caçador começa uma execução e a fonte está ligada e conectada, o tick põe **1 busca por fonte por execução** na fila. O resultado vira import "Maps · {agente} · dd/mm". O Caçador já pula empresas importadas (F3c-1 C4), então a IA não repete o que o Maps trouxe.

## 5. Tetos e custo
| Item | Valor |
|---|---|
| Teto Apify/dia (workspace) | padrão **US$ 2,00**, faixa 0,50..50 (Claude — conferir) |
| Teto Apollo/dia | padrão **20 buscas**, faixa 1..200; `per_page 25` (Claude — conferir) |
| Reserva | Apify = `maxTotalChargeUsd`; Apollo = 0 |
| Acerto | custo = `usageTotalUsd` da execução (?); sem número → custo = reserva |
| Dia | meia-noite America/New_York (igual K-10) |
| Execução presa | > 15 min rodando → abortar no Apify, `failed 'stale'` |

Tela Fontes conectadas: "Hoje: US$ x de y" (Apify) e "n de m buscas" (Apollo). F3d-2 põe as linhas no **Gastos** da F3c-2, agente "Fontes", passo = fonte, por lead no P2b.

## 6. Textos (pt-BR, curto)
- Maps: "A coleta do Google Maps segue os termos do Google. O responsável é o dono do workspace."
- Apollo: "Os dados do Apollo ficam só neste workspace. Não revendemos nem compartilhamos."
- Geral: "Sem LinkedIn: links do LinkedIn são descartados."

## 7. Fases
| Fase | O quê | Precisa |
|---|---|---|
| F3d-1 | conexões, livro, tick, Maps + Apollo no import, telas | 0011 (F3c-1). Migração **0014** não usa nada da 0012/0013 |
| F3d-2 | P2b contatos + Gastos por fonte | F3c-2 (0012). Migração própria **0015** |

## 8. Pronto quando
F3d-1: dono cola a chave Apify (teste passa, tela mostra só os 4 últimos); "Buscar no Maps" Worcester traz leads "Maps · …" sem duplicar os que já existem, com fonte e data em cada valor; repetir a busca cria 0 leads; teto US$ 0,50 bloqueia a segunda busca do dia; sem chave o botão some; Desfazer funciona. Apollo: busca traz empresas sem `.co.uk`.
F3d-2: lead com site e sem e-mail após P2 ganha e-mail do próprio domínio com a URL; Gastos mostra "Fontes · Apify contatos".

## 9. Fora
Outros atores (scraperlink, lukaskrivka, leads-finder, google-search); enrich pago do Apollo; telefones do contact scraper; revenda de dado; filtro de categoria do Maps (vai pelo perfil, F3c-4).

# F3c: Subir lista + Qualificador + Cobertura

Data: 14/11/2026. Status: **Aprovado para planejar (14/11/2026)**.
Depende de: modo econômico (feito, branch `economy-mode`), F3a (tabela `leads`, feito), F3b (Caçador em segundo plano, próximo).
Spec mãe: `2026-11-14-kolmeia-3-areas-design.md` (3 áreas, J1-J3, C1-C13).

Convenção (igual à spec mãe):
- "(decisão do Juan)" = ele decidiu. Não mudar sem perguntar.
- "(decisão do Claude — conferir)" = Claude decidiu no lugar; o Juan pode corrigir.
- "(construtor decide)" = detalhe técnico livre.
- "?" = não verificado (preço, limite, termo de uso).

## Decisões fechadas em 14/11 (2)

| # | Decisão | Quem |
|---|---|---|
| J-1 | Teto diário do Qualificador: padrão **US$ 5/dia**, editável pelo usuário na tela (dentro dos tetos duros que já existem). Dia contado em America/New_York | Juan |
| J-2 | Transparência de gasto é requisito: tela **"Gastos"** mostrando onde foi cada centavo (por agente, passo, modelo, tokens, buscas/leituras web e por lead), gasto de hoje vs teto e controle **"mudar teto"**. Dado já está em `ai_calls`; acrescentar `lead_id` onde faltar. Mostrar **"estimativa US$ X"** antes de qualquer qualificação manual (seção 5.5) | Juan |
| J-3 | Verificação cara (P5) roda dos DOIS jeitos: (A) **automática** só para leads que batem o perfil aprovado e são contactáveis, com **liga/desliga**; (B) **manual**: marca leads (caixinhas) ou "qualificar os próximos N do filtro atual", vê a estimativa e confirma. Os dois obedecem o teto diário | Juan |
| J-4 | Google Places: **depois**. P3 fica desligado até o Juan dar `GOOGLE_PLACES_API_KEY`; o resto funciona sem ela | Juan |
| K-1 | Lead importado aparece em LEADS na hora e conta para duplicata (Caçador C4 "só novos" o exclui). O construtor generaliza `link_lead` (mesma trava e chaves) para aceitar fonte "import"; sem execução de pesquisa sintética | Claude — conferir |
| K-2 | Junção entre listas: guardar todos os telefones/e-mails distintos como valores separados em `lead_fields`, cada um com fonte; nunca sobrescrever | Claude — conferir |
| K-3 | "Contactável" (nível ≥ 1) inclui valor só-importado, mostrado com ⚠ "sem prova". Nível nunca cai em silêncio: campo refutado gera alerta e o nível é recalculado de forma visível | Claude — conferir |
| K-4 | Prioridade da fila: leads do Caçador e que batem o perfil primeiro; depois nível maior; depois os mais antigos; pedido manual fura a fila. Qualificador e Caçador dividem o executor da F3b e o tempo do tick (construtor define a proporção); poucos leads por tick é aceitável | Claude — conferir |
| K-5 | Termos do Places: guardar só `place_id` + valores confirmados por outra fonte; buscar de novo sob demanda | Claude — conferir |
| K-6 | Limites de upload: 5 MB / 5.000 linhas por arquivo; leitura no navegador, envio em lotes com barra de progresso; erro por linha | Claude — conferir |
| K-7 | Perfil aprendido = filtro + ranking + consultas de busca sugeridas; a **versão do perfil usada fica gravada em cada execução** (para medir J3). Não edita a config congelada do agente (A6): tabela própria e versionada | Claude — conferir |
| K-8 | Cobertura: área coberta volta a "não coberta" após **90 dias sem busca**. Lista de cidades: MassGIS ou lista pública equivalente (?); regiões fora de MA aparecem como "fora de MA" | Claude — conferir |
| K-9 | Desfazer import: apaga só os leads criados por aquele import (rastrear `created_by_import` vs já existia) | Claude — conferir |
| K-10 | Teto do workspace continua pausando e avisando (C5); o teto diário do Qualificador zera sozinho todo dia | Claude — conferir |
| K-11 | "Bate o perfil" é regra/filtro (sem chamada de IA extra por lead) | Claude — conferir |

## Decisões fechadas em 14/11

| # | Decisão | Quem |
|---|---|---|
| D1 | O Juan sobe listas que já tem (de outra IA, planilha, scraper). Cada linha vira LEAD na hora, origem "importado", SEM gastar token de IA, sem duplicar (mesmas chaves SQL da F3a) | Juan |
| D2 | A lista também é TREINO: a IA lê a lista como exemplo do que ele quer e aprende o padrão (tipo, porte, região, tipo de obra, sinais, onde achar empresas assim) = "perfil aprendido" | Juan |
| D3 | Lead chega pela metade (só e-mail, só telefone, só nome). O sistema sempre cruza dados para qualificar. "O objetivo é sempre qualificar o lead." | Juan |
| D4 | Uma aba para ver e alimentar: o que já foi buscado, quais áreas do mapa já foram cobertas; app de leads dinâmico | Juan |
| D5 | O Juan delegou ao Claude a estrutura dos agentes e a abordagem | Juan |
| C-a | Abordagem "esteira em cascata": por lead, do mais barato ao mais caro (seção 4 e 7) | Claude — conferir |
| C-b | Agentes na tela: Caçador (até 3), **Qualificador** (NOVO, sempre ligado, 1 por workspace, criado sozinho, teto diário), E-mail e Ligação (F4/F5). Por dentro: um orquestrador; cada passo usa a ferramenta mais barata que resolve | Claude — conferir |
| C-c | "Nível" do lead de 0 a 4. Cada campo guarda fonte e data ("de onde veio"). Valor importado = "importado, sem prova" até ser confirmado | Claude — conferir |
| C-d | Treino = 1 chamada de IA sobre a lista inteira (amostra se for grande). Vira cartão "perfil aprendido" com prova (quais linhas apoiam cada ponto). Só vale depois que o Juan aprova. A lista também serve de gabarito para medir o Caçador (J3) | Claude — conferir |
| C-e | Aba "Cobertura" dentro de LEADS: buscas feitas, áreas cobertas (cidade/ZIP/condado), o que falta | Claude — conferir |
| C-f | Compliance: sem VPN nem truque contra bloqueio; sem raspar Google Maps (usar Places API); sem raspar LinkedIn; dado do Apollo não é revendido; dado subido é privado do workspace (RLS), nunca vai para o repo público | Claude — conferir |
| C-g | Ordem: modo econômico → F3b → F3c. O Qualificador reusa o executor da F3b | Claude — conferir |
| C-h | Formato: CSV e XLSX até um limite; tela de mapear colunas com detecção automática; prévia antes de importar; erro por linha; seguro contra injeção | Claude — conferir |

## 1. Intenção e porquê

| Pergunta | Resposta |
|---|---|
| O que muda | O Juan pode jogar listas prontas dentro da Kolmeia. Elas viram leads e são qualificadas sozinhas. |
| Por quê | Ele já tem listas (outra IA, planilhas, scraper). Hoje elas ficam fora do app e ninguém cruza os dados. |
| Modelo mental | "Subo a lista. Ela vira lead na hora. O Qualificador completa. A Cobertura mostra onde já procurei." |

```
 Lista (CSV/XLSX) ──▶ LEADS (nível 0-1, "importado") ──▶ Qualificador ──▶ nível 2-4
        │                                                   (esteira barata → cara)
        └──▶ Perfil aprendido (Juan aprova) ──▶ Caçador acha mais iguais
```

## 2. Objetivos, não-objetivos, anti-objetivos

### 2.1 Objetivos
| # | Objetivo |
|---|---|
| 1 | Subir CSV/XLSX e cada linha vira lead em segundos, sem IA (D1) |
| 2 | Nenhum lead duplicado: mesma regra de chave da F3a (D1) |
| 3 | Todo lead é qualificado sozinho, do passo mais barato ao mais caro (D3, C-a) |
| 4 | Todo campo mostra "de onde veio" e quando (C-c) |
| 5 | A lista ensina o Caçador, com aprovação do Juan (D2, C-d) |
| 6 | Aba Cobertura: o que já foi buscado e onde (D4, C-e) |

### 2.2 Não-objetivos (agora)
- Envio de e-mail ou ligação (F4/F5). Aqui só se acha e qualifica.
- API paga de enriquecimento (Apollo, Explorium etc.).
- Mapa com polígonos detalhados no 1º corte (fica opcional, F3c-5).
- Importar de Google Sheets/CRM por link. Só arquivo.

### 2.3 Anti-objetivos (nunca)
| Anti-objetivo | Por quê |
|---|---|
| Gastar token de IA no import | D1: importar é grátis e instantâneo |
| Mudar o agente em silêncio | C-d: perfil só vale com OK do Juan |
| Dado inventado (e-mail "chutado" tipo nome.sobrenome@, telefone, decisor) | R18: sem fonte, não existe |
| Raspagem contra termos (Google Maps, LinkedIn), VPN, burlar captcha/bloqueio | C-f |
| Valor importado mostrado como verdade | fica "importado, sem prova" até confirmar |
| Complexidade (telas a mais, configuração demais) | pedido nº 1 do Juan |

## 3. Restrições

| Tipo | Restrição |
|---|---|
| Stack | `kolmeia/app`: Next.js 16, Supabase/Postgres, RLS por workspace (owner/sdr/closer), vitest + PGlite |
| Leads hoje | `0009_leads.sql`: `leads` 1 linha por empresa; chave = `name_key` OU `company_domain_key(website)` OU `company_phone_key(phone)`; lead nasce de `research_candidates` verificado via `link_lead` |
| Executor | F3b: rota de cron `/api/hunter/tick`, caminho sem sessão com token do relógio, lease de 1 por vez, custo nos tetos do workspace (C5) |
| Custo | modo econômico: `lib/ai/routing.ts`, reserva pelo pior caso, chamada encolhe para caber no teto |
| Modelos | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` (`lib/ai/models.ts`) |
| Reuso | `dedupe.ts` (nameKey/domainKey/phoneKey), `csvCell`/`toCsv` (já protegem fórmula), `parseCsv`/`rowsFromCsv` do `baseline.ts` (F3b) |
| Git | `kolmeia/` é repo PÚBLICO: nunca commitar listas, leads, gabaritos, chaves |
| Agente congelado | F3b A6: cliente não muda `agents.config` depois do rascunho. Perfil aprendido precisa de caminho próprio (seção 8) |

## 4. Abordagens para qualificar

| # | Caminho | Prós | Contras |
|---|---|---|---|
| **1** | **Esteira em cascata** (escolhido) | passos grátis resolvem boa parte; IA só onde precisa; custo previsível por lead | mais peças (fila, passos) |
| 2 | 1 mini-pesquisa de IA por lead | simples de montar (reusa o motor) | caro: cada lead paga busca + leitura + Sonnet, mesmo quando o site já tinha o telefone |
| 3 | API paga (Apollo etc.) | rápido, muitos campos | termos proíbem revenda (mata o SaaS); dado sem prova; custo por crédito |

Por que o 1 (decisão do Claude — conferir): o objetivo é qualificar com prova e gastar pouco. O passo grátis resolve "contactável"; a IA cara só confirma o que vale dinheiro (obra ativa, decisor).

## 5. Telas

### 5.1 Subir lista (dentro de LEADS, botão [Subir lista])

```
① Arquivo          ② Colunas                         ③ Prévia              ④ Pronto
┌──────────────┐  ┌─────────────────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ Arraste CSV  │  │ Coluna do arquivo → Campo   │  │ 412 linhas       │  │ 380 leads novos  │
│ ou XLSX      │  │ "Company"     → Empresa  ✓  │  │ 380 novos        │  │ 25 já existiam   │
│ (até ? MB)   │  │ "Tel"         → Telefone ✓  │  │ 25 já existem    │  │   (dados somados)│
│              │  │ "Mail"        → E-mail   ✓  │  │  7 com erro ▸    │  │  7 com erro ▸    │
│ Aba: [Plan1▾]│  │ "Obs"         → Nota        │  │ [tabela 20 linhas│  │ Qualificador já  │
│              │  │ "X"           → (ignorar)   │  │  com status]     │  │ começou ▸        │
│ Nome da lista│  │ ☐ Usar como treino (D2)     │  │                  │  │ [Ver perfil      │
│ [_________] │  │                             │  │ [Voltar][Importar]│  │  aprendido]      │
└──────────────┘  └─────────────────────────────┘  └──────────────────┘  └──────────────────┘
```

| Regra | Detalhe |
|---|---|
| Detecção | por cabeçalho (EN/PT: company/empresa/name, website/site/url, phone/tel/telefone, email/e-mail, city/cidade, contact/contato, title/cargo, notes/obs/nota, zip/cep, state/estado). Sem IA |
| Mínimo por linha | pelo menos 1 de: empresa, site, telefone, e-mail. Senão: erro da linha "sem nada para identificar" |
| E-mail sem empresa | domínio do e-mail vira site provável (exceto gmail/yahoo/outlook etc.: lista igual `SHARED_HOSTS` + webmail) |
| Erro por linha | lista "linha 14: telefone inválido" etc.; linha com erro não entra; o resto entra |
| "Já existe" | soma dados novos ao lead existente; nunca apaga dado que já estava |
| Quem pode | owner/sdr. Closer não vê o botão (J2) |

### 5.2 Lead com nível e "de onde veio"

```
┌ Acme Builders ─────────────────────────── Nível ●●○○○ 2 · site + endereço ┐
│ Telefone  (508) 555-0199   site acmebuilders.com · 14/11  ✓                │
│ E-mail    info@acme...     importado "Lista Cape" · sem prova  ⚠           │
│ Endereço  12 Main St, Worcester   Places · 14/11  ✓                         │
│ Decisor   ?                                                                │
│ Obra ativa ?                                                               │
│ Próximo passo do Qualificador: conferir decisor (IA, ~US$ ?)               │
│ Listas: "Lista Cape" (14/11) · Caçador A (10/11)                           │
└────────────────────────────────────────────────────────────────────────────┘
```

| Nível (C-c) | Quer dizer | Cor |
|---|---|---|
| 0 | só identidade (nome) | cinza |
| 1 | contactável: telefone OU e-mail com fonte | azul claro |
| 2 | site + endereço confirmados | azul |
| 3 | decisor achado (nome + cargo, com prova) | verde |
| 4 | quente: obra ativa com prova | laranja |

- Lista LEADS ganha coluna "Nível" e filtro "Nível ≥ N".
- Fontes possíveis: `importado` · `site` · `Places` · `IA` · `pesquisa` (motor atual).
- Nível conta só valores confirmados (fonte ≠ importado). Importado não sobe nível sozinho (decisão do Claude — conferir).
  Exceção (K-3): telefone/e-mail importado já deixa o lead "contactável" (nível ≥ 1), com ⚠ "sem prova". Nível nunca cai em silêncio: campo refutado gera alerta e o nível é recalculado de forma visível.
- Vários telefones/e-mails de listas diferentes ficam todos, cada um com sua fonte; nunca sobrescreve (K-2).

### 5.3 Cartão do Qualificador (em AGENTES)

```
┌ Qualificador ─────────────────────────── ● sempre ligado  [Pausar] ┐
│ Na fila: 380      Hoje: 52 qualificados    Gasto hoje: US$ 0,40 / 5,00 │
│ Níveis:  0 ▓▓ 40   1 ▓▓▓▓▓ 210   2 ▓▓▓ 98   3 ▓ 22   4 ▏ 10          │
│ Passos de hoje: grátis 48 · Places 20 · IA leve 15 · IA forte 4      │
│ ⚠ Places desligado (sem chave)                                        │
│ Teto por dia [US$ 5 ▾ mudar]   Teto por lead [US$ ? ▾]               │
│ Verificação cara automática [ligada ▾]   [Ver gastos ▸]              │
└───────────────────────────────────────────────────────────────────────┘
```

- Teto por dia: padrão US$ 5, editável aqui e em "Gastos" (J-1); dia em America/New_York.

- Criado sozinho, 1 por workspace, não pode ser apagado nem duplicado; pode ser pausado (C-b).
- Não conta no máximo de 3 Caçadores (C6).
- Bateu teto diário: pausa até o dia seguinte e avisa; volta sozinho (K-10). Teto do workspace (C5) continua pausando e avisando.

### 5.5 Tela "Gastos" (J-2) e qualificação manual (J-3)

```
┌ Gastos ───────────────────── Hoje: US$ 1,90 de 5,00 ▓▓▓░░  [mudar teto] ┐
│ Ver por: [Agente] [Passo] [Modelo] [Lead]        Período [Hoje ▾]      │
│ Agente        passo      modelo   tokens ent/saí  buscas  leituras  US$ │
│ Qualificador  P4 IA leve haiku    120k / 18k        -        -     0,22 │
│ Qualificador  P5 forte   sonnet    80k / 12k        6        9     1,10 │
│ Caçador A     pesquisa   sonnet   210k / 30k       14       22     0,58 │
│ ▸ clicar numa linha abre os leads (custo por lead)                      │
└─────────────────────────────────────────────────────────────────────────┘
```

| Regra | Detalhe |
|---|---|
| Fonte | `ai_calls` (e chamadas do Places, quando ligado). Acrescentar `lead_id` onde faltar, para somar por lead |
| Cada centavo | toda linha de gasto tem agente, passo, modelo, tokens, buscas/leituras web e lead (quando houver) |
| Teto | mostra gasto de hoje vs teto; "mudar teto" edita o teto diário dentro dos tetos duros existentes |
| Quem vê | owner/sdr; closer não vê (construtor confirma com RLS) |

Qualificação manual (J-3 B), em LEADS:
- Caixinhas por lead, ou botão "qualificar os próximos N do filtro atual".
- Antes de rodar: **"estimativa US$ X"** (pior caso, mesma conta da reserva do modo econômico) + [Cancelar] [Confirmar].
- Pedido manual fura a fila (K-4) e obedece o teto diário; se a estimativa passa do que resta no dia, avisa antes de confirmar.

### 5.4 Aba Cobertura (LEADS → [Leads] [Cobertura])

```
┌ Cobertura ───────────────────────────── [Condado ▾] [Só sem busca ☐] ┐
│ Buscas feitas                                                         │
│ 14/11  Lista Cape (importada)    Cape Cod      412 linhas  380 novos  │
│ 10/11  Caçador A                 Boston        web         22 novos   │
│ 08/11  Pesquisa avulsa           Worcester     web         15 novos   │
│                                                                       │
│ Cidades (MA)          leads  buscas  última                           │
│ Boston                  44      3    10/11   ████                     │
│ Worcester               15      1    08/11   ██                       │
│ Barnstable               9      1    14/11   █                        │
│ Springfield              0      0    -       ░ não coberta [Caçar ▸]  │
│ ... 351 cidades; resumo: 38 cobertas · 313 sem busca                  │
└───────────────────────────────────────────────────────────────────────┘
```

| Regra | Detalhe |
|---|---|
| 1º corte | tabela de cidades de MA (lista fixa, 351) agrupada por condado, com contagem. Sem mapa |
| Mapa (opcional, F3c-5 fim) | Leaflet de cdnjs + GeoJSON público das cidades de MA (MassGIS ?) pintado por contagem. Só se a tabela já funcionar |
| "Coberta" | cidade com ≥ 1 busca (Caçador/pesquisa com região que inclui a cidade, ou lista importada com leads dela). Expira: após 90 dias sem busca volta a "não coberta" (K-8) |
| Lista de cidades | MassGIS ou lista pública equivalente (?); regiões fora de MA aparecem como "fora de MA" (K-8) |
| [Caçar ▸] | abre a criação do Caçador já com a região preenchida |
| Alimentar | o Juan pode marcar à mão "já procurei aqui fora do app" (fonte + data) (decisão do Claude — conferir) |

## 6. Dados (esboço; nomes e detalhes: construtor decide)

```
lead_imports          uma por arquivo subido
  id, workspace_id, created_by, file_name, sheet_name,
  row_count, new_count, merged_count, error_count,
  mapping jsonb, use_as_training bool, status, created_at
  (o arquivo bruto NÃO é guardado; só as linhas mapeadas)

lead_import_rows      linha mapeada + resultado (prévia, erros, gabarito)
  id, import_id, workspace_id, row_number, data jsonb,
  lead_id null, outcome ('new'|'merged'|'error'), error text

lead_fields           "de onde veio" por campo
  id, workspace_id, lead_id, field ('phone'|'email'|'website'|
     'address'|'city'|'zip'|'contact_name'|'contact_title'|...),
  value, source ('import'|'site'|'places'|'ai'|'research'),
  source_ref (import_id | url | place_id | research_check_id),
  seen_at, confirmed bool

qualifier_queue       estado da esteira por lead
  lead_id (pk), workspace_id, next_step, attempts,
  spent_usd, last_step_at, done_reason, locked_until

coverage_marks        cobertura por cidade
  workspace_id, town, county, source ('hunter'|'research'|
  'import'|'manual'), ref_id, searched_at, leads_found

learned_profiles      perfil aprendido (seção 8)
  id, workspace_id, import_id, agent_id null, profile jsonb,
  evidence jsonb, status ('proposed'|'approved'|'rejected'),
  approved_by, approved_at
```

| Ponto | Regra |
|---|---|
| Lead sem candidato | hoje `leads` nasce de `research_candidates`. Import entra na MESMA trava e chave de `link_lead` (advisory lock por workspace): o construtor generaliza `link_lead` para aceitar fonte "import", sem execução de pesquisa sintética (K-1). Lead importado aparece em LEADS na hora e conta para duplicata (Caçador C4 "só novos" o exclui). Teste de duplicata da F3a tem de passar também para import |
| Desfazer import | apaga só os leads criados por aquele import; rastrear `created_by_import` vs já existia (K-9) |
| Gastos | `ai_calls` ganha `lead_id` onde faltar; chamadas do Places entram no mesmo ledger (J-2) |
| Perfil | tabela própria e versionada; cada execução grava a versão do perfil usada (K-7) |
| Origem | `origin_kind` ganha `'import'` (+ `origin_import_id`). Mostra "Importado · nome da lista" |
| Chaves | lead precisa de chaves próprias (nome/domínio/telefone) ou buscar em `lead_fields`; o construtor garante que um lead só-importado é achado pela busca de duplicata do Caçador (C4 "só novos") |
| Nível | coluna `level` em `leads`, recalculada por função SQL a partir de `lead_fields` + provas |
| RLS | tudo por workspace, igual `leads`; closer lê só `lead_fields` dos leads dela; `lead_imports` e `lead_import_rows` só owner/sdr |
| Retenção | `lead_import_rows.data` pode ter dado pessoal: apagar a lista apaga as linhas (cascade); leads já criados ficam (construtor decide se oferece "apagar leads desta lista") |

## 7. A esteira (Qualificador), passo a passo

Roda no executor da F3b (cron, sem sessão, 1 lease por vez), dividindo o tempo do tick com o Caçador (proporção: construtor define; poucos leads por tick é aceitável). Leads novos do Caçador e do import entram na fila sozinhos.

Prioridade da fila (K-4): 1) leads do Caçador e leads que batem o perfil; 2) nível maior primeiro; 3) mais antigos primeiro. Pedido manual (5.5) fura a fila.

```
 lead ─▶ P1 juntar ─▶ P2 site ─▶ P3 Places ─▶ P4 IA leve ─▶ P5 IA forte ─▶ fim
        (grátis)     (grátis)   (pago/chamada) (Haiku)       (Sonnet/Opus)
   cada passo: já tem o que precisa? pula.  Teto bateu? para.
```

| Passo | Faz | Custo | Pula quando | Regras |
|---|---|---|---|---|
| P1 Juntar | soma dados de outros registros com mesmo domínio/telefone/nome (outros imports, candidatos) | grátis | nada a juntar | nunca sobrescreve valor confirmado com não confirmado |
| P2 Site | baixa o site da própria empresa (home + até 3 páginas: contato/sobre) e extrai JSON-LD schema.org (Organization/LocalBusiness), `tel:`, `mailto:`, endereço | grátis (sem IA) | sem site; ou telefone+e-mail+endereço já confirmados | ver "Regras de fetch" abaixo |
| P3 Places | Google Places API (oficial): telefone, endereço, site, nota, status (aberta/fechada) | ~US$ ? por chamada | sem chave (`GOOGLE_PLACES_API_KEY` ausente = passo desligado); ou nível ≥ 2 | **desligado até o Juan dar a chave (J-4); o resto funciona sem ela.** Só campos pedidos (field mask); guardar só `place_id` + valores confirmados por outra fonte, buscar de novo sob demanda (K-5) |
| P4 IA leve | Haiku organiza o que P2/P3 trouxeram (tipo de empresa, cidade, porte) e extrai contato de texto da página já baixada | centavos ? | nada novo para organizar | sem web_search; só lê texto já baixado; saída estruturada |
| P5 IA forte | Sonnet (Opus só no rigor "rigoroso") confere verdade: obra ativa, decisor, temperatura. Mesmas regras de prova do motor (URL vista, trecho, data) | ~US$ 0,25+ por chamada ? (menor "Checar" do modo econômico) | lead não bate o perfil (aprovado) ou nível < 2 | dois jeitos (J-3). (A) automático: só leads contactáveis (nível ≥ 1) que batem o perfil aprovado ("bate" = regra/filtro, sem IA extra: K-11), com liga/desliga. (B) manual: o usuário marca leads ou "próximos N do filtro", vê "estimativa US$ X" e confirma. Os dois obedecem o teto diário |

Regras de fetch do P2 (decisão do Claude — conferir):
- Só `http/https`, portas 80/443; bloquear IP privado/local (proteção SSRF), checar depois de cada redirecionamento (máx. 3).
- Respeitar `robots.txt`; User-Agent honesto da Kolmeia; 1 pedido por segundo por domínio.
- Timeout 5 s, máx. 1 MB por página, só HTML. Sem login, sem formulário, sem captcha, sem JS headless.
- Bloqueou (403/429/captcha): marca "site bloqueou" e segue para o próximo passo. Nunca tentar contornar (C-f).
- E-mail achado vale só se apareceu na página (R18: guardar URL). Nunca adivinhar padrão.

Paradas (decisão do Claude — conferir; teto diário = US$ 5 por padrão, editável: J-1; teto por lead: valor a definir pelo construtor, editável):

| Para quando | Resultado |
|---|---|
| Lead chegou ao nível 4, ou ao máximo que o perfil pede | `done_reason = 'complete'` |
| Gasto do lead bateu o teto por lead | `'lead_cap'`; mostra "parou no teto" |
| Teto do dia do Qualificador ou teto do workspace (C5) | Qualificador pausa e avisa; fila fica. Teto diário zera sozinho (dia em America/New_York); teto do workspace segue pausando e avisando (K-10) |
| Empresa fechada (Places) ou site fora do ar + nada mais | `'dead'`, sugere descartar (o Juan decide) |
| 3 erros seguidos no mesmo passo | pula o passo, anota |

- Reserva de custo: igual ao modo econômico (pior caso, chamada encolhe, `ai_calls` registra tudo). Places também entra no ledger (custo por chamada ?).
- Lead novo do Caçador já vem nível 2-4 com prova: a fila só roda o que falta.

## 8. Treino do perfil (D2, C-d)

```
 lista marcada "usar como treino"
   └─▶ 1 chamada de IA (Sonnet ?) sobre amostra (até ? linhas)
         └─▶ cartão "Perfil aprendido" (proposto)
               ├─ [Aprovar] ─▶ vale para Caçador X e para o filtro do P5
               ├─ [Editar e aprovar]
               └─ [Descartar]
```

```
┌ Perfil aprendido · Lista Cape (412 linhas) ──────────── proposto ┐
│ Tipo:     construtoras residenciais multifamiliar  (linhas 3,9,14…) │
│ Porte:    5-50 funcionários ?                       (linhas 2,7…)    │
│ Região:   Cape Cod + South Shore                    (78% das linhas) │
│ Obras:    condomínios 6-40 unidades                 (linhas 11,40…)  │
│ Sinais:   alvará recente, "now leasing"             (linhas …)       │
│ Onde achar: sites de alvará das cidades, associações locais         │
│ Usar em: [Caçador Construtores Boston ▾]                            │
│                         [Descartar] [Editar] [Aprovar]              │
└─────────────────────────────────────────────────────────────────────┘
```

| Regra | Detalhe |
|---|---|
| Custo | 1 chamada por lista (o import em si continua sem IA). Estimativa no botão antes de rodar |
| Amostra | lista grande = amostra estratificada por cidade (tamanho: construtor decide, ?) |
| Conteúdo | filtro + ranking + consultas de busca sugeridas (K-7); a versão usada fica gravada em cada execução (medir J3) |
| Prova | cada ponto cita as linhas que o apoiam; ponto sem linhas não aparece |
| Injeção | texto das linhas vai para a IA como DADO delimitado, nunca como instrução; notas tipo "ignore as regras" não mudam nada |
| Aprovar | owner/sdr. Cria versão nova do perfil; o Caçador usa a versão aprovada na PRÓXIMA execução. Não edita `agents.config` direto (A6 da F3b): caminho próprio, auditado (construtor decide) |
| Gabarito (J3) | lista marcada como treino também vira gabarito: relatório de precisão/cobertura do Caçador contra ela (reusa `baselineReport` da F3b) |

## 9. Compliance (não é aconselhamento jurídico)

| Ponto | Regra |
|---|---|
| Google Maps | não raspar. Só Places API oficial, com chave do Juan |
| Termos do Places | Google limita guardar dado do Places (place_id pode guardar; outros campos com limite de cache ?). Construtor LÊ os termos antes do P3 e ajusta (ex.: guardar só place_id + dado confirmado em outra fonte) |
| LinkedIn | não raspar, nem pelo P2 (domínio bloqueado) |
| Apollo/APIs pagas | não usar para qualificar; dado de teste do Apollo não é revendido |
| Bloqueio de site | sem VPN, proxy rotativo, troca de IP ou burla de captcha (C-f) |
| Dado pessoal | listas podem ter nome/e-mail de pessoa: privado do workspace (RLS), nunca no repo público, nunca em log |
| CAN-SPAM | não muda (aqui não se envia nada) |

## 10. Fases

| Fase | O quê | Pronto quando |
|---|---|---|
| **F3c-1 Subir lista** | `lead_imports`, `lead_import_rows`, `lead_fields`; origem `import`; tela 5.1 (arquivo → colunas → prévia → pronto); CSV + XLSX (5 MB / 5.000 linhas, leitura no navegador, lotes com progresso: K-6); duplicata pela regra da F3a; erros por linha; desfazer import (K-9) | o Juan sobe um CSV e um XLSX de teste; leads aparecem em LEADS como "Importado · lista"; subir a mesma lista de novo cria 0 leads; nenhuma chamada em `ai_calls`; fórmula `=HYPERLINK(...)` numa célula não executa em lugar nenhum |
| **F3c-2 Esteira grátis** | Qualificador (criado sozinho, cartão 5.3); `qualifier_queue` no executor da F3b; P1 + P2; "de onde veio" e nível na tela 5.2 | um lead só com site ganha telefone/e-mail do próprio site, com URL; site que bloqueia vira "site bloqueou" sem erro; IP privado recusado (teste); custo do dia = 0 |
| **F3c-3 Places + IA + Gastos** | P3 (desligado sem chave, J-4), P4, P5 (automático com liga/desliga + manual com estimativa); tetos por lead e por dia (padrão US$ 5, editável); pausa e aviso; tela "Gastos" (5.5) com `lead_id` em `ai_calls` | sem chave: aviso no cartão e esteira segue; com chave: lead só-nome ganha endereço; teto do dia bate e o Qualificador pausa sem reservar além; P5 automático só roda em contactável que bate o perfil e some com o liga/desliga; manual mostra estimativa e obedece o teto; "Gastos" soma por agente, passo, modelo e lead e bate com `ai_calls` |
| **F3c-4 Perfil aprendido** | botão de treino, chamada única, cartão 8, aprovar/editar/descartar, versão usada pelo Caçador; relatório de gabarito | o Juan sobe uma lista do `data/gold/` como treino, vê o cartão com linhas de prova, aprova; a próxima execução do Caçador usa o perfil; sem aprovação nada muda |
| **F3c-5 Cobertura** | `coverage_marks`; aba 5.4 com tabela de cidades MA por condado; [Caçar ▸]; marca manual; mapa só se sobrar | o Juan vê quais cidades já têm busca e quais não; um import com leads de Barnstable marca Barnstable; [Caçar ▸] abre o Caçador com a região |

Cada fase: testes vitest/PGlite, nenhum teste antigo quebra, nada toca o Supabase real (aplicar migração = checklist manual com o Juan, C9).

## 11. O que fica para o construtor decidir

- Generalizar `link_lead` vs. candidato numa "execução de import" (a duplicata tem de ser a mesma).
- Onde moram as chaves do lead só-importado; `level` coluna vs. view.
- Biblioteca de XLSX (conferir licença, versão e alertas de segurança; a do npm `xlsx` está velha ?); limite de tamanho/linhas (proposta: 5 MB / 5.000 linhas ?).
- Parse no navegador (prévia) vs. no servidor; mas a gravação e a duplicata são sempre no servidor/SQL.
- Tamanho do lote por tick e divisão de tempo com o Caçador no mesmo executor.
- Formato de `profile` e versão do perfil; como o Caçador lê a versão aprovada sem quebrar A6.
- Normalizar região de texto livre (`region_text`) para cidades de MA (lista fixa + apelidos tipo "Cape" → 15 cidades ?).
- Mapa: biblioteca e fonte do GeoJSON (só CDN permitido; arquivo pequeno).
- Textos exatos da tela (português curto; nunca "pearchat").

## 12. Perguntas em aberto

| # | Pergunta | Status |
|---|---|---|
| 1 | Teto do Qualificador por dia e por lead | **Fechada (J-1):** US$ 5/dia, editável. Teto por lead: o construtor propõe um padrão editável |
| 2 | Chave do Google Places | **Fechada (J-4):** depois; P3 desligado até a chave |
| 3 | P5 automático ou só manual | **Fechada (J-3):** os dois, com liga/desliga no automático |
| 4 | Toda lista vira gabarito ou só as marcadas | Aberta. Padrão atual: só as marcadas "usar como treino" (D2, C-d) |

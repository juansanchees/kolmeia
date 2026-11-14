# Kolmeia: engenharia harness (desenho-mãe)

Data: 13/11/2026. Status: rascunho para o Juan aprovar.

Convenção: o que está marcado "(proposta do Claude)" é sugestão minha, não fato lido nem decisão do Juan. "?" = valor desconhecido (lista completa na seção 17).

Este documento é o guarda-chuva. Cada item das trilhas da seção 14 ganha o seu próprio desenho curto e o seu plano antes de qualquer código.

## 1. Intenção e porquê

### 1.1 O que o Juan disse
| Tema | Nas palavras dele |
|---|---|
| Onde | quer fazer nos EUA primeiro |
| Base | quer a base "sempre rodando" e nutrindo o app "com leads novos sempre" |
| Promessa | "o usuário que contratar minha ferramenta terá acesso aos meus leads quentes" |

### 1.2 Leitura
- O produto vendido é ACESSO A LEADS QUENTES QUE SE RENOVAM SOZINHOS, com prova (fonte + data).
- O envio de e-mail é o jeito de usar esses leads. Não é o produto em si.
- Primeiro cliente de teste: Air HVAC (Massachusetts), nicho construção/HVAC.

### 1.3 Como o produto chega ao cliente (proposta do Claude, o Juan ainda não confirmou)
| Etapa | Quem opera | Idioma |
|---|---|---|
| 1. começo | o Juan opera a ferramenta para o cliente (serviço) | o que o cliente vê: relatório e reuniões |
| 2. depois | o cliente usa sozinho (self-service) | português, para donos brasileiros de empresas de serviço nos EUA |

## 2. Objetivos, não-objetivos, anti-objetivos

### 2.1 Objetivos
| # | Objetivo |
|---|---|
| 1 | A base recebe empresas e sinais novos toda semana sem ninguém apertar botão |
| 2 | Todo lead quente tem motivo e prova (fonte + data) |
| 3 | O cliente abre o app e vê os leads quentes novos do ramo e da região dele |
| 4 | O cliente age: aprova a sequência, o motor envia, as respostas voltam, passa para a closer |
| 5 | O que acontece no envio volta e melhora a base |

### 2.2 Não-objetivos por agora
Ficam nas telas como "em breve" (ver seção 13).

| Fica de fora | Nota |
|---|---|
| Pool de aquecimento | já descartado em `kolmeia/docs/engenharia-envio.html` |
| Base de 450M contatos | o texto "450M+ CONTATOS B2B" está nas telas de desenho |
| Venda de domínios e caixas | |
| Variantes A/Z | |
| Passos livres na sequência | |
| WhatsApp e ligação como canal dentro do app | a ligação continua valendo como uso da lista (padrão-ouro) |
| Brasil | |

### 2.3 Anti-objetivos (falha mesmo que funcione)
| # | Falha |
|---|---|
| 1 | Vender dado cru do Google Maps |
| 2 | O mesmo lead quente entregue a vários clientes do mesmo ramo e região |
| 3 | Qualquer e-mail sair sem aprovação humana (piloto automático desligado por padrão) |
| 4 | Afirmar algo sem fonte |
| 5 | Dado de cliente passando por marketplace de MCP não oficial |
| 6 | LinkedIn raspado |
| 7 | SMS ou WhatsApp frio |

## 3. Restrições

| Tema | Fato ou limite | Origem |
|---|---|---|
| Stack | Next.js 16 + Supabase + Vercel | `kolmeia/app/README.md` |
| Código | vive em `kolmeia/app` (fonte única) | decisão 13/11 |
| Migrações | `0001_foundation`, `0002_research`, `0003_email`, `0004_research_hardening`, `0005_scheduler` | `kolmeia/app/supabase/migrations/` |
| Chave de admin | não existe no host do app; regra R14 | README do app |
| RLS | forçada nas tabelas por espaço (workspace) | migrações |
| E-mail | CAN-SPAM: endereço físico + descadastro de um clique | README do app |
| Google Maps | termos de uso: volume modesto, sem revenda | `CLAUDE.md` do projeto |
| Juan | não é engenheiro: explicar em palavras simples | `CLAUDE.md` |
| Orçamento | ? | seção 17 |
| Git | `kolmeia/` ainda não está no git (aparece como `??`) | `git status` |
| Banco | a Kolmeia ainda não tem projeto Supabase próprio | README do app, "O que o dono precisa fazer" |
| Design de UI | é do dono: `kolmeia/design-telas/` (creme #FBF8F2, mel #F5A400, Inter + Space Grotesk) | `design-telas/SPEC.md` |

## 4. Abordagens consideradas

Pergunta: como manter a base sempre alimentada?

| | A. Servidor próprio 24h nos EUA | B. Agentes de IA agendados | C. Comprar o sinal pronto |
|---|---|---|---|
| Como | worker com conectores agendados | IA pesquisa por região, com busca na web | contrato com fornecedor de dados |
| Custo | baixo e fixo (valor: ?) | variável; a pesquisa de Falmouth custou US$ 1,60 para 20 empresas (dado do Juan, não achei o registro no repo) | mensalidade (fornecedor e preço: ?) |
| Já existe | scripts em `data/ma_sweep/scripts/` | a Pesquisa no `kolmeia/app/src/lib/research/` | nada |
| Bloqueio de prefeitura | IP americano resolve parte (o IP do Brasil foi bloqueado em várias) | idem, mas a IA contorna lendo outras páginas | o fornecedor resolve |
| Ponto fraco | cada cidade é um conector escrito à mão | caro em volume | dependência e cobertura desconhecida |
| Cobre o país | devagar | devagar e caro | rápido |

ESCOLHA recomendada: A como base, B por cima (a IA só entra nos candidatos já quentes). C fica como opção para sair de Massachusetts.

Nota de processo: o Juan pediu este desenho logo depois desta recomendação, sem objetar. Trato como a escolha dele, a confirmar na aprovação.

## 5. Visão geral: 5 camadas

```
 FONTES PÚBLICAS (alvarás, projetos, Maps, sites)
        |
 [1 FÁBRICA]  worker 24h -> conectores -> normaliza -> dedupe -> CATÁLOGO GLOBAL
        |
 [2 QUALIFICAÇÃO]  regra fixa dá temperatura -> IA confirma só os quentes -> prova
        |
 [3 DISTRIBUIÇÃO]  territórios (ramo x região) -> 1 cliente por lead -> feed "novos hoje"
        |
 [4 AÇÃO]  enriquece e-mail -> motor de envio -> respostas -> closer
        |
 [5 APRENDER]  bounce, pessoa errada, resposta, descadastro voltam para a base
        |__________________________________________________________^
```

| Camada | O que faz | Onde roda | Estado hoje |
|---|---|---|---|
| 1 Fábrica | traz empresas e sinais novos sozinha | worker nos EUA (host: ?) | só scripts soltos em `data/ma_sweep/scripts/` |
| 2 Qualificação | temperatura por regra; IA confirma os acima do corte | worker + Pesquisa existente | Pesquisa existe por cliente, sem corte nem catálogo |
| 3 Distribuição | decide quem recebe cada lead quente | banco + app | não existe |
| 4 Ação | e-mail, envio, respostas, closer | app (Vercel) + Supabase | motor E1 feito, E2-E6 falta |
| 5 Aprender | fecha o ciclo | banco | não existe |

### 5.1 O "harness" em si: o que mantém agentes e automação nos trilhos
| Trilho | Como funciona |
|---|---|
| Regras que viram teste | R1-R12, R13-R19, P1-P10 (de `docs/mvp-harness.md`) mais L1-L8 (seção 12); cada uma com teste que falha se alguém quebrar |
| Orçamento por dia | teto de gasto de IA; excedente vai para fila (L4; já existe `workspace_settings.ai_daily_cap_usd` e `ai_limits`) |
| Prova obrigatória | sem `source_url` e `seen_at`, o fato não entra (L1, P1) |
| Aprovação humana | nada sai sem o ok (R1); piloto automático desligado por padrão |
| Ensaio por padrão | toda campanha nasce em ensaio; envio real só o dono liga |
| Botão de emergência | `workspace_settings.sending_paused` (desenho do motor); relógio lê primeiro |
| Batimento (heartbeat) | cada peça grava "estou viva": `scheduler_runs` para o relógio, `connector_runs` para os conectores |
| Conjunto de avaliação com gabarito | `data/gold/` (5 planilhas); rodado antes de mudar prompt, fonte ou modelo (P7, R19) |

## 6. Camada 1: fábrica de leads

### 6.1 O worker
- Processo sempre ligado, em Docker, em servidor nos EUA, fora da Vercel (host e custo: ?).
- Conversa com o banco por um papel próprio do Postgres, com direito só nas tabelas do catálogo (proposta do Claude). É a única credencial nova do sistema. Não é a chave de admin do Supabase (R14 continua valendo para o app).
- Por que fora da Vercel: precisa rodar por horas, de IP americano, com cadência própria.

### 6.2 Conectores que existem hoje (leitura de `data/ma_sweep/`)
Contagens = linhas dos CSVs em `data/ma_sweep/permits`, `projects` e `maps` (sources/*.md, run de 11/11/2026).

| Conector | Plataforma | Linhas | Papel |
|---|---|---|---|
| Universo Google Maps (`maps/universe.csv`) | Maps via `maps_driver.py`, 208 cidades selecionadas | ~12.630 (contado com `wc`, ? se houver quebra de linha dentro de campo) | SÓ completa telefone e site. Nunca é motivo de lead (L2) |
| Boston permits | CKAN CSV | 5.297 | sinal público; só mostra o requerente, não a construtora |
| Cambridge permits | Socrata (3 datasets) | 89 novas + 1.000 reforma + 782 mecânico | sinal público; tem nome da empresa |
| Somerville permits | Socrata | 1.157 | sinal público; tem empresa |
| Worcester permits | ArcGIS FeatureServer | 1.670 | sinal público; sem valor declarado |
| Sudbury permits | PDFs mensais, `pypdf` | 271 | sinal público; PDF frágil |
| MassBuilds | API JSON, 6.739 registros no estado | 1.902 mantidos | sinal público (projetos); muitos "planning" velhos |
| BPDA Article 80 | ArcGIS REST | 410 | sinal público; sem desenvolvedor |
| MSBA escolas | PDF | 142 | sinal público; nome de empresa por heurística |
| Cambridge devlog | Socrata | 54 | sinal público; só desenvolvedor |
| MassHousing | comunicados, transcrito à mão | 9 | sinal público; manual |

Fontes que NÃO funcionam hoje (não contornar): OpenGov e ViewPoint Cloud (robots.txt `Disallow: /`), mass.gov (403), PermitEyes (403 em Falmouth e Chelsea agora), Newton, Brookline, Arlington, Quincy e outras (403 ou fora do ar a partir do IP do Brasil). Precisam de nova tentativa com IP dos EUA (item aberto).

### 6.3 Cadência (proposta do Claude)
| Tipo | Cadência | Por quê |
|---|---|---|
| Sinal (alvarás, projetos) | semanal; diário onde a fonte for barata | é o que dá a "novidade" do lead |
| Descoberta (Maps, novas empresas) | mensal | volume modesto por termos de uso |

### 6.4 Contrato de um conector
| Item | Regra |
|---|---|
| Entrada | região e janela de datas; nada mais |
| Saída | linhas no formato do esquema de alvará de `data/ma_sweep/BRIEF.md`: `source,town,permit_id,issued_date,address,declared_value_usd,permit_type,work_class,use,description,contractor_name,contractor_phone,contractor_license,applicant_name,owner_name,units,sqft,source_url` |
| Idempotência | chave = `source` + id da fonte; rodar duas vezes não duplica |
| Prova | toda linha leva `source_url` e `seen_at` (L1) |
| Educação | confere `robots.txt`; cerca de 1 requisição por segundo por host; sem login, sem CAPTCHA, sem formulário |
| Falha | isolada: um conector caindo não para os outros (L7) |
| Registro | cada execução grava uma linha em `connector_runs` (início, fim, linhas lidas, novas, erro curto) |

### 6.5 Normalização e duplicata
| Chave | Uso | Origem da ideia |
|---|---|---|
| nome normalizado | une "Turner" e variações | `name_utils.py`, `build_aggregate.py` |
| domínio do site | une empresa com nomes diferentes | idem |
| telefone | une com o Maps | idem |
| ponte pessoa para empresa | Cambridge dá a pessoa licenciada, não a firma | `build_crosswalk.py`, `person_firm_crosswalk.csv` |

## 7. Camada 2: qualificação

### 7.1 Temperatura por regra fixa (sem IA)
Quatro níveis, como no padrão-ouro (`docs/pesquisa-padrao-ouro.md`). Os limites são "?" até calibrar com `data/gold/`.

| Sinal | Entra na conta como | Limite |
|---|---|---|
| Recência do alvará | dias desde `issued_date` | ? |
| Valor declarado | `declared_value_usd` | ? |
| Tipo de obra | `work_class` e `use` (obra nova e multifamiliar pesam mais; mecânico mostra o HVAC concorrente) | ? |
| Quantidade de sinais | alvarás e projetos casados com a empresa | ? |

| Nível | Referência no gold (Boston e Cape) | Regra |
|---|---|---|
| Muito quente | 39 | sempre com sinal; valores ? |
| Quente | 17 | sempre com sinal; valores ? |
| Morno | 335 | sinal pequeno ou perfil forte no Maps (inferência do padrão-ouro) |
| Frio | 401 | sem sinal e perfil fraco |

### 7.2 IA só acima do corte
| Passo | Regra |
|---|---|
| Checagens (já existem na Pesquisa) | existe e está ativa; tem obra agora; é o perfil |
| Segunda passada | outra chamada vê só as provas, nunca a conclusão da primeira (P5) |
| Fontes | duas independentes concordando, senão "?" (P9) |
| Orçamento | teto diário; acima dele o candidato espera numa fila (L4) |

### 7.3 MCP
- Permitido só como ferramenta desta camada de IA: busca, leitura de página, verificação de e-mail.
- Só de fornecedor oficial. Nunca o marketplace não oficial para dado de cliente.
- Segue R13 e R14: a IA lê e rascunha; não envia, não aprova, não apaga.

### 7.4 Saída
Lead quente = empresa + motivo + prova + temperatura + gancho sugerido (frase citando a obra real, como no padrão-ouro).

## 8. Camada 3: distribuição

- Território = ramo (trade) x região. Cada espaço assina territórios.
- Exclusividade (proposta do Claude, decisão do Juan, D1): cada lead quente vai para UM espaço por ramo e região por 30 dias, depois é liberado.
- Por quê: cinco instaladores mandando e-mail ao mesmo construtor queimam o lead para todos e a marca da Kolmeia.
- Feed: "N leads novos hoje". O usuário decide: fica / sai / mais como esta (os mesmos botões da Pesquisa de hoje).

| O cliente vê | O cliente nunca vê |
|---|---|
| leads atribuídos a ele | o catálogo cru |
| prova, gancho, "perguntar por" | linhas só do Maps como se fossem lead vendável |

## 9. Camada 4: ação

### 9.1 Enriquecimento sob demanda
Quando o usuário fica com um lead: achar o decisor e o e-mail (site da empresa primeiro, parceiro pago depois), verificar, guardar em cache para nunca pagar duas vezes (L5).

| Papel | Candidatos vistos numa listagem de marketplace (avaliar nos sites oficiais) | Preço |
|---|---|---|
| Achar e-mail | Apollo, Findymail | ? |
| Verificar e-mail | NeverBounce, Bouncer, Emailable | ? |
Capacidades, cobertura nos EUA e termos de cada um: ? (não verificado).

### 9.2 Motor de envio
Desenho aprovado em `kolmeia/docs/engenharia-envio.html`.

| Item | Estado |
|---|---|
| 7 portões: aprovado, blocklist, horário, limite do dia, intervalo, 1 pessoa por empresa, caixa saudável | 1 e 2 existem; 4 e 7 em parte |
| E1 (relógio, rota protegida, `scheduler_runs`) | implementado e testado localmente: 635 testes, só ensaio, ainda não aplicado em banco real (dado do Juan) |
| E2 a E6 | pendentes (seção 14) |
| Antes do E6 | domínio de prospecção separado; 2 ou 3 caixas pagas com SPF, DKIM e DMARC; endereço físico para o rodapé; ok do dono da Air HVAC |

### 9.3 Respostas, classificação, closer
Já existe: IA classifica (interessado, não agora, fora, pessoa errada, descadastro), resumo pronto, "Passar pra closer". Falta ler as caixas por IMAP no relógio (E5).

## 10. Camada 5: aprender

| Evento | Efeito na base |
|---|---|
| bounce | e-mail marcado morto para todos os espaços |
| pessoa errada | procurar outro decisor da mesma empresa |
| respondeu interessado | sobe o peso de empresas parecidas |
| descadastro | aquele espaço nunca mais contata aquela pessoa |
| reunião marcada | vira caso para "mais como esta" |

## 11. Dados

### 11.1 Catálogo global (novo; não é por espaço)
| Tabela | Para quê | Colunas-chave (proposta do Claude) | Regra que protege |
|---|---|---|---|
| `catalog_companies` | uma linha por empresa | `id`, `name`, `name_key`, `domain`, `phone`, `town`, `state`, `trade`, `first_seen_at` | L2 (campo só do Maps não vira motivo) |
| `catalog_people` | decisores | `id`, `company_id`, `full_name`, `role`, `confidence`, `source_url`, `seen_at` | L1 |
| `catalog_signals` | alvarás e projetos casados com a empresa | `id`, `company_id`, `kind`, `external_id`, `issued_date`, `declared_value_usd`, `work_class`, `use`, `address`, `source`, `source_url`, `seen_at` | L1, idempotência por `source`+`external_id` |
| `catalog_evidence` | prova das checagens de IA | `id`, `company_id`, `check_type`, `result` (`ok`/`não`/`?`), `pass`, `source_url`, `seen_at`, `snippet`, `model`, `prompt_version` | L1, P1, P5 |
| `catalog_contact_status` | e-mail verificado ou morto, em cache | `person_id`, `email`, `status`, `verified_by`, `verified_at` | L5, L6 |
| `connector_runs` | batimento dos conectores | `id`, `connector`, `started_at`, `finished_at`, `rows_read`, `rows_new`, `error_code` | L7 |

### 11.2 Distribuição (novo)
| Tabela | Para quê | Colunas-chave (proposta do Claude) |
|---|---|---|
| `territories` | ramo x região | `id`, `trade`, `region` |
| `workspace_territories` | o que cada espaço assinou | `workspace_id`, `territory_id` |
| `lead_assignments` | quem recebeu qual lead | `id`, `company_id`, `workspace_id`, `territory_id`, `temperature`, `assigned_at`, `exclusive_until`, `decision` |
| `lead_feed_events` | "novos hoje", decisões, para aprender | `id`, `assignment_id`, `kind`, `at` |

### 11.3 Tabelas por espaço que ficam (lidas nas migrações 0001-0005)
| Grupo | Tabelas |
|---|---|
| Base | `workspaces`, `workspace_members`, `company_profiles`, `workspace_settings` |
| Pesquisa | `research_runs`, `research_sources`, `research_candidates`, `research_checks`, `research_evidence`, `research_lists`, `research_list_items`, `research_jobs` |
| IA | `ai_calls`, `ai_limits`, `ai_access` |
| E-mail | `sender_profiles`, `mailboxes`, `suppressions`, `email_campaigns`, `email_prospects`, `email_replies`, `email_messages`, `email_approvals`, `email_send_log`, `email_unsub_tokens` |
| Relógio | `scheduler_state`, `scheduler_runs` |

### 11.4 Como um lead mantido vira `email_prospects`
```
lead_assignments (decision = fica)
   -> research_candidates + research_list_items  (a lista aprovada, P3)
   -> email_prospects  (nome, e-mail verificado, gancho, source_url)
```
Mantém o desenho atual: o E-mail só recebe o que foi aprovado na Pesquisa (P3). A cópia leva a prova junto.

### 11.5 Acesso
| Quem | Pode |
|---|---|
| Cliente (RLS) | ler o catálogo só através de `lead_assignments` do seu espaço |
| Worker (papel próprio) | escrever só nas tabelas `catalog_*` e `connector_runs` |
| Ninguém na Vercel | chave de admin (R14) |

## 12. Regras novas que viram teste (L1-L8)

Entram junto de R1-R12 e P1-P10, cada uma com pelo menos um teste que falha se for quebrada. Os testes de banco rodam em PGlite com a RLS aplicada (como já faz `kolmeia/app/tests/db`).

| # | Regra | Teste que prova |
|---|---|---|
| L1 | Todo fato do catálogo tem `source_url` e `seen_at` | inserir sem um dos dois é recusado pelo banco |
| L2 | Campo vindo só do Maps nunca é motivo de lead nem sai em exportação | empresa só com Maps não gera atribuição; exportação não contém campo Maps-only |
| L3 | Um lead quente fica com no máximo 1 espaço por ramo e região dentro do prazo | segunda atribuição dentro de `exclusive_until` falha |
| L4 | Teto diário de gasto da IA de qualificação; o excedente vai para a fila | com teto estourado, candidato fica em fila e nenhuma chamada sai |
| L5 | Enriquecimento pago só depois que o usuário escolhe o lead; resultado em cache | sem decisão "fica" nenhuma chamada paga; segunda chamada lê o cache |
| L6 | Bounce mata o e-mail para todos; descadastro vale para o espaço que enviou | bounce em A bloqueia em B; descadastro em A não bloqueia B |
| L7 | Falha de um conector não para os outros e aparece no batimento | conector que lança erro deixa os demais rodarem e grava `error_code` |
| L8 | Sem LinkedIn raspado, sem SMS, sem WhatsApp frio | não existe caminho de código; teste varre domínios e canais permitidos (reforça R11) |

## 13. Telas (o design do Juan)

12 telas em `kolmeia/design-telas/`. Layout comum e tokens em `design-telas/SPEC.md`. Nunca escrever "Instantly" na interface.

| Tela | Camada | Estado e mudança |
|---|---|---|
| `Copiloto.dc.html` | 2, 4 | serve agora como pedido em linguagem natural à Pesquisa |
| `BuscaLeads.dc.html` | 3 | MUDA: vira o feed de leads quentes + busca dentro dos leads atribuídos. O texto "450M+ CONTATOS B2B" sai; entra o tamanho real da base (número: ?) |
| `Main.dc.html` (Campanhas) | 4 | serve |
| `CampanhaLeads.dc.html` | 3, 4 | MUDA: o mesmo "450M+" sai; importa só leads atribuídos |
| `CampanhaEditor.dc.html` | 4 | serve (3 passos; passos livres e A/Z com selo "em breve") |
| `CampanhaConfig.dc.html` | 4 | serve; ganha horário, fuso, limite por campanha, intervalo (E2) |
| `CampanhaAnalytics.dc.html` | 5 | serve |
| `ContasEmail.dc.html` | 4 | serve; aquecimento com selo "em breve"; ganha saúde da caixa (E4) |
| `Unibox.dc.html` | 4 | serve (respostas e closer) |
| `CRM.dc.html` | 4 | serve |
| `Relatorios.dc.html` | 5 | serve |
| `Agentes.dc.html` | 1 a 5 | "em breve" para a maioria; "manter N alvos na fila" fica como ideia futura (visto em `docs/raw/re_instantly.md`, seção 15.4) |

### 13.1 Telas que faltam (proposta do Claude)
| Tela nova | Para quê |
|---|---|
| Aprovação antes do envio | ver o texto exato por pessoa e aprovar (R1) |
| Descadastro e rodapé | página pública `/u/[token]` e editor do rodapé com endereço físico |
| Diário | ler `email_send_log` sem poder apagar |
| Botão de emergência | pausa tudo do espaço (`sending_paused`) |
| Batimento das esteiras | estado do relógio e dos conectores (`scheduler_runs`, `connector_runs`) |

## 14. Ordem de construção

Duas trilhas que mexem em arquivos diferentes e podem andar em paralelo. Cada item recebe um desenho curto e um plano antes de qualquer código.

### 14.1 Trilha Motor (desenho em `kolmeia/docs/engenharia-envio.html`)
| # | Item | Pronto quando |
|---|---|---|
| E2 | Portões novos: horário, fuso, limite por campanha, 9 + 5 min, 1 por empresa | 5 testes novos passam, um por portão |
| E3 | Rodízio de caixas e caixa fixa por pessoa | o passo 2 sai pela mesma caixa do passo 1 |
| E4 | Saúde da caixa, rampa, pausa por bounce, botão de emergência | uma caixa com bounce alto para sozinha e a campanha segue |
| E5 | Respostas no relógio e blocklist automática | uma resposta para a sequência sem ninguém abrir a tela |
| E6 | Primeiro envio real em 1 campanha pequena | 10 e-mails reais entregues e anotados no diário |

### 14.2 Trilha Base
| # | Item | Pronto quando |
|---|---|---|
| B1 | Schema do catálogo + importar o que existe em `data/ma_sweep` e `data/gold` | tabelas criadas, importação idempotente, L1 e L2 com teste |
| B2 | Worker + os conectores de alvará que já existem, agendados | uma semana de execuções seguidas em `connector_runs`, sem ninguém apertar botão |
| B3 | Temperatura por regra + feed de leads quentes | a regra reproduz as 4 temperaturas do gold dentro de uma tolerância (?) |
| B4 | IA confirma os quentes | cada quente tem 2 fontes ou "?"; L4 com teste |
| B5 | Territórios, exclusividade e tela de feed | L3 com teste; cliente vê só o que foi atribuído |
| B6 | Parceiro de e-mail e verificação | L5 com teste; e-mail verificado em cache |
| B7 | Volta do aprendizado | L6 com teste; bounce e descadastro refletem na base |
| B8 | Segundo estado | uma região fora de Massachusetts rodando o mesmo caminho |

### 14.3 Ordem recomendada
E2 e B1 primeiro, em paralelo. Depois E3 com B2, E4 com B3, E5 com B4. E6 só quando as pré-condições da seção 9.2 estiverem prontas. B8 por último.

Nota técnica: o desenho do motor chama as colunas novas de "migração 0005", mas `0005_scheduler.sql` já existe com o relógio. O que falta do motor vai em migrações novas (0006 em diante) e a base também (ver Conflitos).

## 15. Decisões do Juan (abertas)

| # | Pergunta | Opções | Recomendação |
|---|---|---|---|
| D1 | Quem pode receber o mesmo lead quente? | 1 cliente por ramo e região por 30 dias; ou lead compartilhado | 1 cliente por 30 dias (protege o lead e a marca) |
| D2 | Onde roda o worker e quanto pode custar por mês? | servidor americano simples e fixo; ou serviço gerenciado | servidor simples em Docker; teto mensal: ? |
| D3 | Qual parceiro acha e verifica e-mail? (precisa de conta e cartão do Juan) | os da seção 9.1 ou outro | avaliar 2 nos sites oficiais e testar com 20 contatos da Air HVAC antes de assinar |
| D4 | Começar operando para o cliente e depois abrir o self-service? | sim; ou self-service desde o início | sim, operar primeiro (proposta do Claude, seção 1.3) |
| D5 | Qual o próximo ramo e a próxima região depois de HVAC em Massachusetts? | outro ramo em MA; ou HVAC em outro estado | uma só variável por vez: o mesmo ramo em outro estado (proposta do Claude) |
| D6 | Colocar `kolmeia/` no git? | sim, agora; ou depois | sim, agora (o trabalho já está só no disco do Juan) |
| D7 | Criar o projeto Supabase da Kolmeia? | sim; ou seguir só em teste local | sim, antes de B1 e antes de aplicar a `0005` |

## 16. O que fica para o construtor

| Chamada | Quando decidir |
|---|---|
| Nomes finais das tabelas e colunas (os da seção 11 são proposta) | no desenho de B1 |
| Limites exatos da temperatura | depois de rodar a regra contra `data/gold/` (B3) |
| Internos de cada conector (paginação, parse de PDF, tratamento de erro) | em B2, um conector por vez |
| Framework do worker (fila, agendador, repetição) | no desenho de B2, medindo o que `data/ma_sweep/scripts/` já resolve |
| Como casar empresa com alvará (limiar do casamento aproximado) | em B1/B2, com o gold como gabarito |
| Formato da fila de IA acima do teto | em B4 |
| Forma de ler as caixas por IMAP no relógio | em E5 |

## 17. Itens "?"

| Item | Por que é desconhecido | Como descobrir |
|---|---|---|
| Orçamento mensal total | o Juan não disse | perguntar no D2 |
| Host e custo do worker | não escolhido | D2; comparar 2 opções |
| Parceiro de e-mail: nome, preço, cobertura, termos | só vi nomes numa listagem de marketplace | ler os sites oficiais; teste com 20 contatos (D3) |
| Limites da temperatura | precisam de calibração | rodar a regra contra `data/gold/` |
| Custo da IA por lead quente | só há um dado solto (Falmouth, US$ 1,60 para 20 empresas, do Juan) e não está no repo | medir em `ai_calls` em B4 |
| Tamanho real da base de leads quentes | a base ainda não existe como catálogo | contar após B1 |
| Linhas do universo do Maps (~12.630) | contagem com `wc`, pode haver quebra de linha em campo | contar com leitor de CSV em B1 |
| Cobertura das cidades bloqueadas | IP do Brasil foi barrado em muitas | refazer a varredura de um IP dos EUA |
| PermitEyes (Falmouth, Chelsea) | respondeu 403 em 11/11 depois de ter funcionado em 04-06/11 | repetir de IP americano; senão ligar para a prefeitura |
| Mesmo lead para vários clientes é aceitável? | decisão de negócio | D1 |
| Quando o projeto Supabase da Kolmeia sai | não criado | D7 |
| Passo 5 e seguintes do assistente do Lead Finder do concorrente | não visto | só se virar necessário |
| Tempo e data de cada item B1-B8 | não estimado, para não inventar | estimar depois do desenho curto de cada um |

## Conflitos encontrados

| # | Meu texto ou o do Juan | O que o repo diz | O que fiz |
|---|---|---|---|
| 1 | "migrations 0001-0005" e motor chama o conteúdo novo de migração 0005 | `0005_scheduler.sql` já existe e é só o relógio; o desenho do motor (`engenharia-envio.html`, seção 06) diz que as colunas novas são a "migração 0005" | mantive 0001-0005; as colunas do motor e do catálogo vão em 0006 em diante |
| 2 | Portão "1 pessoa por empresa por dia" (desenho do motor, citando R7) | `docs/mvp-harness.md` R7 diz "no máximo 2 pessoas da mesma empresa por dia" | usei 1, como no desenho do motor; confirmar qual vale |
| 3 | Intervalo "9 min + até 5 min sorteados" | o README do app ainda descreve 60-180 s (E2 muda isso) | mantive 9 + 5 como alvo de E2 |
| 4 | R6 (bounce > 2% após 50 envios) | o Instantly usa 5% após 200; o próprio R6 marca "calibrar" | mantive R6; calibrar |
| 5 | Falmouth usado como fonte de alvará e custo de US$ 1,60 | PermitEyes passou a dar 403 em 11/11; o custo não está registrado no repo | mantive o texto do Juan; marcado como não verificado na seção 17 |
| 6 | "E1 feito, 635 testes" | não achei esse número em arquivo do repo; só o README do app descreve o relógio | mantive o dado do Juan |
| 7 | "Kolmeia não tem projeto Supabase" | o README do app já pede "projeto Supabase separado", consistente; mas memória do projeto cita migrações aplicadas em outro projeto (`radar-hvac`) | sem mudança; D7 trata |
| 8 | "Mesma lista, só Maps não sai em exportação" | o universo do Maps em `data/gold/` tem 97,6% telefone e 81,4% site, e o gold exporta essas colunas | L2 vale para o produto novo; o gold continua como gabarito interno |

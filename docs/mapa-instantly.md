# Mapa do Instantly → Kolmeia

> **Observado em 12/11/2026 na conta do Juan; conta vazia, sem dados.** Só estrutura, layout e fluxos. Marca, cores, fontes, ícones e textos são da Kolmeia (ver `brand/identidade.md`).
> Protótipo: `prototipo/kolmeia-telas.html` → botão **Mapa de telas** (tem a opção "Ver vazio").

## Casca (shell)
| Peça | Instantly | Kolmeia |
|---|---|---|
| Trilho de ícones (~48 px) | avatar do workspace + 8 ícones com tooltip; foguete e avatar embaixo | igual; ícones desenhados por nós; + **Diário** separado por linha tracejada (extra) |
| Coluna da seção (~250 px) | título + subnavegação/filtros, botão de esconder | igual (`Esconder coluna`) |
| Abas no topo | por seção | igual |
| Painel de IA à direita (~380 px) | nome, frase de contexto, 2–3 cartões com botão, chips, campo com anexo/mic/enviar; fecha | igual, chamado **Kolmeia IA**; cartões mudam por tela |
| Pílula no topo | "Get All Features" | **Ver planos** |
| Tema | escuro | claro e escuro (escuro desenhado de verdade) |
| Celular | não observado | trilho vira barra de baixo (IA, Leads, Campanhas, Caixa, Menu); coluna e IA viram gavetas |
| Estado vazio | cabeçalho + linhas cinzas sumindo, ícone, título, 1 linha, 1–2 botões | igual, com o hexágono da marca; ligar em Mapa de telas → "Ver vazio" |

## Ordem do trilho
| # | Instantly | Kolmeia | Rota |
|---|---|---|---|
| 1 | Instantly AI | Kolmeia IA | `#copiloto` |
| 2 | Lead Finder | Buscar leads | `#buscar` |
| 3 | Engage | Campanhas | `#campanhas` |
| 4 | Agents | Agentes | `#agentes` |
| 5 | CRM | CRM | `#crm-tarefas` |
| 6 | Email Accounts | Contas de e-mail | `#contas` |
| 7 | Unibox | Caixa única | `#caixa` |
| 8 | Reports | Relatórios | `#relatorios` |
| extra | (Audit Logs fica em Settings) | Diário | `#diario` |
| menu do avatar | e-mail, Language, Theme, Credits, Notifications, Settings, Invite, What's new, Help, Logout | igual em português; Créditos: **—** |

## Telas por seção
| Seção | Instantly (observado) | Kolmeia |
|---|---|---|
| Kolmeia IA | coluna: New Chat, Artifacts, Memory, Tasks, Settings, histórico; cartão "2 públicos" com rádio + Run on autopilot / Add to campaign / Preview / Skip; campo grande | igual; "Rodar no automático" cria **rascunho na fila de aprovação** |
| Buscar leads › Encontrar | People/Local/Creators; FILTERS (Job Titles … Website Visitors); 2 chaves; Load/Save; "450M+" | igual; sem número de base: "sua Pesquisa + listas"; + filtros Alvará e Temperatura; Criadores = em breve |
| Buscar leads › Leads | All Leads, Lists (+), Campaigns (+); tabela FULL NAME/TITLE/COMPANY | igual; lista **Massachusetts inteiro** (abas da planilha) e página do contato moram aqui |
| Buscar leads › Visitantes | Website Visitors/Setup/Billing; banner, 4 números, tabela | mesmo layout, marcado **Em breve** |
| Campanhas (lista) | Search, All statuses, All tags, engrenagem, Automate, Create New; NAME/TYPE/STATUS/ACTIVITY/OUTCOME | igual |
| Criar campanha | abre "Untitled Campaign" + modal Continue manually / Generate with AI | igual ("Campanha sem título") |
| Campanha › topo | voltar, nome, Analytics · Editor · Leads · Settings, Draft, Launch, ⋮ | Análise · Editor · Leads · Opções; Rascunho, **Iniciar**; + botão **Aprovar N** (extra) |
| Campanha › Análise | período, %, Share, Diagnose, 7 números, Performance Trend, Step analytics/Activity/Bounces | igual; abertura e clique "Desligado"; US$ sempre "—"; Atividade = Diário filtrado |
| Campanha › Editor | assunto (raio de IA), corpo grande, Add variant / Edit variant A, "+" passo, barra de ferramentas embaixo | igual; passos empilhados com espera entre eles; prévia com lead real no "olho" |
| Campanha › Leads | prompt People/Local/Creators, START FROM, OU: Upload CSV / Enter Emails / Google Sheets / Lead Finder | igual (vazio); com leads vira tabela e o import fica em **Adicionar leads**; Google Planilhas = em breve |
| Campanha › Opções | Accounts To Use; Schedule & Limits (chips e formulário); CRM & Tags; Advanced settings (fechado) | igual |
| Agentes | Search, All types, All statuses, lista/grade, Create Agent; tabela | igual; 3 exemplos (vendas, respostas, entregabilidade) com **chave de aprovação humana** |
| CRM › Tarefas | saudação, busca, This week, Create task, To do/Done, Start tasks, cartão com 4 contadores, Weighted pipeline, Closed won | igual; tarefas tiradas dos dados de exemplo |
| CRM › Oportunidades | busca, quadro/lista, Filters, Sort, "N deals · $", Create opportunity; colunas Interested · Meeting booked · Meeting completed (+ Won) | igual; **Passar pra closer** move para Reunião marcada |
| Contas de e-mail | abas Accounts · Deliverability Tests; Search/Type/Status/Tags, ação em massa, Add or Buy; EMAIL/TAGS/TYPE/STATUS/HEALTH SCORE | igual; + enviados/limite e aquecimento na célula de status; painel lateral da caixa mantido |
| Adicionar contas | 4 cartões: Pre-Warmed (Sold Out), AirMail (New), DFY Google, Connect Existing | só **Conectar existente** ativo; os outros 3 "Em breve" |
| Conectar existente | Gmail/G-Suite, Office 365/Outlook, IMAP/SMTP | igual |
| Gmail | oAuth (Recommended) x App Password | **Senha de app ativa** (3 passos); oAuth "Em breve" |
| Caixa única | abas Email · Calls · SMS; Status (+, busca, 9 status); All Campaigns, AI Sales Agents, All Inboxes, More | E-mail · Ligações (**sem SMS**); status + Não agora e Descadastro |
| Relatórios | Overview/Outreach/Sales/AI Agents/Automation/Workspaces; Last month, Share, Settings; blocos com "View ›" | igual; números da IA que não temos ficam "—" |
| Configurações | 14 itens (Account … Calls & SMS); Account = dados, senha, segurança | mesmos itens; "Ligações" sem SMS; + **Remetente** (nome legal + endereço, CAN-SPAM) e **Diário** |

## Adaptado ou cortado (por quê)
| O quê | Decisão | Motivo |
|---|---|---|
| SMS (aba e config) | cortado | regra do produto: nunca SMS frio |
| "450M+ contatos" | trocado | não temos base própria; não inventar número |
| Compra de caixas (3 cartões) | "Em breve" | não temos o que vender ainda |
| oAuth Google | "Em breve" | primeira versão usa senha de app |
| Piloto automático / agentes | sempre com aprovação | nada sai sem humano aprovar |
| Valores em US$ / créditos | "—" | sem preço ou crédito definido |
| Diário | extra (trilho + Configurações + Atividade da campanha) | dono quer "saber tudo"; decidir se o ícone fica |
| Remetente | extra | endereço físico obrigatório no rodapé |
| Aprovar envios | extra | fila de aprovação por campanha |
| Visitantes do site | "Em breve" | fora da primeira versão |

## Não observado (desenho nosso)
- Telas **com dados** de qualquer tabela (conta estava vazia).
- **Advanced settings** da campanha: preenchido com o que a ajuda pública descreve (parar ao responder, parar a empresa, rastrear abertura, 1º e-mail só texto, cabeçalho de descadastro, intervalo mínimo + aleatório). *Não observado, baseado na ajuda pública.*
- Aba **Deliverability Tests**.
- Fluxo de **criação de agente**.
- CRM › **Inbox** e CRM › **Leads**.
- Sub-páginas de **Relatórios** (Outreach, Sales, AI Agents, Automation, Workspaces).
- Sub-páginas do **copiloto** (Artifacts, Memory, Tasks, Settings).
- Abas **Calls** e **SMS** da Unibox.
- Qualquer modal além de: "como criar a campanha", "Lead Finder Agent" (promo), menu do avatar.
- Versão de celular.

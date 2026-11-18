# Motor de dados próprio + agente ao vivo

Data: 17/11/2026. Status: **aprovado pelo Juan (17/11/2026)**, incluindo a seção 11 (inteligência).
Convenção: "(Juan)" = decidido por ele nesta conversa; "(Claude — conferir)" = escolha minha; "?" = não verificado.

## 1. Ideia em 1 linha
A Kolmeia passa a ter **a própria base de leads, compartilhada entre todos os clientes**, montada por **robôs próprios** (sem Apollo, sem API de dados de terceiros), começando por **construtoras em Massachusetts** e servindo **qualquer nicho** depois. O agente mostra o trabalho **ao vivo**.

## 2. Por quê
- O Juan quer competir com Apollo/Instantly sem depender deles: "Eu quero ter algo próprio, eu mesmo desenvolver, onde eu posso buscar leads, igual o Apollo faz." (Juan)
- Foco de mercado: área de construção primeiro, sem se limitar a ela. (Juan)
- Hoje o agente funciona, mas parece morto: o botão não dá retorno, a tela não atualiza, desligar/ligar não roda na hora (diagnóstico de 17/11, seção 9). (fato)
- Primeiro cliente e prova: Air HVAC. (Claude — conferir)

## 3. Objetivos, não-objetivos, anti-objetivos

| Tipo | Item |
|---|---|
| Objetivo | Base com o máximo possível de construtoras/empreiteiras/incorporadoras de MA, cada dado com fonte e data |
| Objetivo | Sinal "ativo agora" (alvará, projeto público) ligado à empresa |
| Objetivo | Qualquer cliente pede nicho + cidade; a IA monta a receita; o que a base já tem sai na hora; o que falta os robôs buscam |
| Objetivo | Agente com "Rodar agora" e painel ao vivo (etapas, contagem, gasto, último achado) |
| Não-objetivo (agora) | Outros estados, cobrança, API pública, revenda de dados |
| Não-objetivo | Novas integrações com Apollo, Shovels, RapidAPI ou similares. As que já existem ficam como estão (Claude — conferir) |
| Anti-objetivo | Base grande e suja: lead sem fonte, duplicado ou inventado |
| Anti-objetivo | Furar bloqueio de site (trocar IP para driblar limite, ignorar robots.txt, resolver CAPTCHA) |
| Anti-objetivo | Lead pessoal exposto sem jeito de pedir remoção |

## 4. Decisões já tomadas

| # | Decisão | Quem |
|---|---|---|
| D1 | Base **compartilhada** entre todos os clientes (jeito Apollo). Substitui a "conta zerada" de 14/11 | Juan |
| D2 | **Robôs próprios**, sem API de dados de terceiros | Juan |
| D3 | Começa por **construção em MA** | Juan |
| D4 | Receita por nicho no jeito **C**: a IA monta a receita, parte de uma receita pronta quando existe, e salva a receita que deu bons leads | Claude — conferir (o Juan não escolheu entre A/B/C explicitamente) |
| D5 | VPN do Juan só como "estar nos EUA". Nunca trocar de IP para driblar bloqueio. Site bloqueado por robots.txt = pula | Juan (VPN) / Claude (regra) |
| D6 | Desenho do motor antes do painel ao vivo; o painel entra neste mesmo desenho | Juan |
| D7 | Régua de qualidade: o app tem que bater as listas padrão-ouro feitas no Claude Code (`data/gold/`), mesma lista e mesma cidade (acertos de empresa + provas). O painel oferece "Rápido / Caprichado" (modelo e tempo maiores = lead mais caro) | Claude — conferir (vem da pergunta do Juan: "vai funcionar tão bem quanto aqui?") |
| D8 | Carga inicial da base: só o que é coleta nossa (CSVs de `data/ma_sweep`: Maps do robô próprio, alvarás, projetos, crosswalk) e o que o Caçador acha na web. Valor com `source` de terceiro (Apollo, Google Places API, Shovels, RapidAPI) **não entra** na base compartilhada (termos de uso + D2) | Claude — conferir |
| D9 | Entrega na Fase 1: script de operador (Juan/Claude), com chave de serviço, cria um `lead_imports` de `kind = 'kb'` no workspace da Air HVAC. Não há tela de admin na Fase 1 | Claude — conferir |
| D10 | Entrega é **cópia** + ligação guardada (lead do cliente ↔ `kb_companies.id`). Valores novos não sobrescrevem o lead do cliente. **Remoção propaga** (adiado, D14): apaga/suprime a pessoa ou empresa em todos os workspaces | Claude — conferir |
| D11 | (adiado, D14) Canal de remoção na Fase 1: e-mail público na landing + página de privacidade; tratamento manual pelo operador, registrado em `kb_removals`. Formulário público só depois | Claude — conferir |
| D13 | Dados de pessoa: na base entram nome, cargo e telefone da empresa. Endereço residencial nunca. Celular pessoal só se divulgado como contato de trabalho. Do Not Call: checagem é de quem liga, com aviso na tela antes de ligar (sem assinatura do registro federal por enquanto) | Juan |
| D14 | Remoção/opt-out fica FORA da Fase 1 (empresa pequena, uso interno). Volta antes de vender dados para fora (com registro de data broker) | Juan |
| D12 | `kb_jobs` guarda quem pediu (`requested_by_run`/`workspace_id` opcional). O cliente só vê os jobs que ele disparou; o resto aparece só como contagem agregada | Claude — conferir |

## 5. Abordagens consideradas

**Origem dos dados**

| Opção | Troca | Escolha |
|---|---|---|
| APIs de terceiros (Apollo etc.) | Rápido, mas dependente e sem diferencial | Rejeitada (Juan) |
| Robôs próprios em fontes públicas | Lento de construir, dado exclusivo (alvará, licença), custo baixo por lead | **Escolhida** |

**Dono da base**

| Opção | Troca | Escolha |
|---|---|---|
| Uma base por cliente | Exclusiva, mas cresce devagar e cada um paga a coleta | Rejeitada |
| Base compartilhada | Cresce a cada busca; o mesmo lead pode aparecer para concorrentes | **Escolhida** (Juan) |

**Como o cliente busca outro nicho**

| Opção | Troca |
|---|---|
| A. Receitas prontas escritas por nós | Qualidade alta, poucos nichos |
| B. IA monta a receita | Qualquer nicho no dia 1, qualidade variável |
| **C. Misto** | B, partindo de receita pronta quando existe; receitas que geram reunião viram padrão |

## 6. Como funciona

```
Cliente: "construtoras em Worcester"
  ↓
IA monta a RECEITA (1 onde estão · 2 sinal de agora · 3 quem decide) → cliente aprova
  ↓
BASE KOLMEIA (compartilhada) ── já tem e está fresco? → entrega na hora (copia para os leads do cliente)
  ↓ falta / velho
FILA DE COLETA → ROBÔS: registros públicos · alvarás · Maps (robô próprio) · sites · verificador de e-mail
  ↓
Cada valor entra com fonte + data → deduplica → BASE → leads do cliente
  ↓
Painel ao vivo mostra cada etapa
```

### 6.1 As 4 máquinas

| Máquina | O quê | Já existe | Fase |
|---|---|---|---|
| M1 Registros públicos | Licenças de construtor (CSL), registro de reformas (HIC), registro estadual de empresas (diretores), alvarás de prefeituras, projetos públicos | Scripts de 5 cidades + projetos em `data/ma_sweep/scripts/` (Python, sem commit) | 1 |
| M2 Robô de sites | Entra no site, acha telefone, e-mail, página de equipe, nomes e cargos | Leitor grátis de site do Qualificador | 1 |
| M3 Verificador de e-mail | Descobre o formato do e-mail e confere MX/SMTP | Não | 2 |
| M4 Rede dos usuários | Assinaturas e respostas de campanhas, com permissão | Não | depois |
| Google Maps | Robô próprio (gosom, Docker), volume baixo | Rodou 208 cidades, 12.630 empresas | 1 |

Fontes de M1 para MA: lista pública confirmada para CSL e HIC, mas o **download em massa é ?**. Se não houver, fazer um pedido pela lei de registros públicos de MA (Claude — conferir). Quantidade total de construtoras em MA: **?** (buscar no Census County Business Patterns, NAICS 23).

### 6.2 Dados (base compartilhada)
Tabelas novas **sem workspace_id** (Claude — conferir os nomes):
- `kb_companies`: empresa canônica (nome, domínio, telefone principal, endereço, cidade, estado, tipo, NAICS).
- `kb_people`: pessoa ligada à empresa (nome, cargo).
- `kb_values`: cada valor com `entity`, `field`, `value`, `source`, `source_url`, `seen_at`, `confidence`. É o mesmo princípio de `lead_fields`, que tem fonte por valor.
- `kb_signals`: alvará/projeto (endereço, valor declarado, data, tipo de obra) ligado à empresa.
- `kb_recipes`: receita por nicho (fontes, termos, filtros, sinal, decisor) + métrica de resultado.
- `kb_jobs`: fila de coleta (fonte, cidade, estado, progresso, erro).
- `kb_removals`: pedidos de remoção/opt-out, que valem para todos os clientes (adiado, D14).

Acesso: cliente nunca lê a base crua. Só funções do servidor entregam e copiam para os leads do workspace, pelo caminho de import existente (`import_lead_rows`/`find_lead`, deduplicação e "Desfazer"). A RLS da base nega tudo a `authenticated` (Claude — conferir).

Deduplicação: domínio > telefone normalizado > nome normalizado + cidade. Os nomes de licença (pessoa) se ligam à empresa pelo crosswalk que já existe (`build/person_firm_crosswalk.csv`).

Frescor: cada valor tem `seen_at`. Na Fase 1, o limite de "fresco" é **?** (proposta: 90 dias para telefone e site, 30 dias para sinal).

### 6.3 Onde os robôs rodam
- **Fase 1:** no Mac do Juan, com VPN dos EUA. Scripts Python que gravam no Supabase de produção por uma chave de serviço própria do robô, guardada só no Keychain. (Claude — conferir)
- **Fase 3:** um servidor nos EUA (VPS ou worker) com a mesma fila `kb_jobs`. Vercel não serve, porque a função tem limite de tempo.
- Ritmo: no máximo ~1 requisição/s por site, `robots.txt` respeitado, User-Agent honesto. São as regras do BRIEF da varredura.

### 6.4 Agente ao vivo (painel)
Diagnóstico de 17/11: o Caçador funciona (rodou em 17/11, achou 20 empresas, gastou US$ 1,30), mas:
1. `AgentPowerButton.tsx:23-27` ignora a resposta do botão.
2. O run começa até 1 minuto depois, pelo cron, e `agentes/[id]` não se atualiza.
3. `AgentDetail` não mostra execução em andamento.
4. Religar não roda na hora, porque `next_run_at` é mantido (`0010_hunter.sql:104`).

Conserto:
- Botão **"Rodar agora"**: coloca `next_run_at = now()` e dispara um tick. O estado aparece em segundos.
- **Painel ao vivo** no agente: lê `research_runs` (status, `progress`, `spent_cost_usd` contra `max_cost_usd`), `research_candidates` e `hunter_ticks`, a cada ~3 s enquanto estiver rodando (polling; realtime é opcional).
- Na lista de agentes: "● Trabalhando", "Rodou há 2h, achou 20" ou "Próxima: 24/11".
- Quando o motor existir, as etapas dos robôs (`kb_jobs`) aparecem no mesmo painel.

Visual: mesmo padrão de marinho, mel e hexágono do resto do app.

## 7. Fases

| Fase | Entrega | Pronto quando |
|---|---|---|
| 0 | Agente ao vivo ("Rodar agora" + painel + estado na lista) | Clicar → ver etapas e leads chegando sem recarregar |
| 1 | Base de construção em MA: tabelas `kb_*`, M1 (licenças + alvarás com VPN + projetos), Maps próprio, M2 sites, deduplicação, entrega para o workspace | Air HVAC recebe construtoras de MA com telefone + fonte; cobertura medida contra o total do Census (?) |
| 2 | M3 verificador de e-mail próprio | E-mail "conferido" sem serviço de terceiro, IP separado |
| 3 | Receita por IA (C) + busca na base dentro do app + robôs em servidor nos EUA | Cliente novo pede outro nicho e recebe leads |
| 4 | Outros estados e nichos | Uma fonte nova = um robô novo |

## 8. Regras (não negociáveis)
- Só dados públicos. Sem login, sem criar conta, sem CAPTCHA, sem paywall, sem trocar IP para furar bloqueio.
- LinkedIn: só sem login/cookie, perfis públicos, volume baixo, uso interno, nunca a conta do Juan. Maps: volume baixo. Nenhum dos dois é revendido.
- A licença CSL é de pessoa e o telefone pode ser celular pessoal. Antes de ligar: lista Do Not Call. SMS frio nunca.
- Pedido de remoção vale para a base inteira (`kb_removals`) (adiado, D14).
- Antes de vender dados para fora: checar registro de "data broker" nos estados que exigem (?). Não vale para a Fase 1 (uso interno + clientes da Kolmeia).
- Repo público: nenhum dado real de lead, nenhuma chave em código ou teste.
- Backup de produção antes de cada migração.

## 9. O que fica para o construtor
- Nomes exatos de tabelas e colunas, índices, regra de normalização de nome.
- Formato do `progress` no painel e intervalo de polling.
- Organização dos scripts Python dentro de `kolmeia/` (hoje estão em `data/ma_sweep/`, fora do git).

## 10. Pendências com "?"
- Download em massa de CSL/HIC: existe?
- Total de construtoras em MA (Census NAICS 23).
- Limites de frescor.
- Registro de data broker: quais estados exigem e quando.

## 11. Inteligência da IA (aprovada 17/11)
Pedido do Juan (17/11): "quero que a i.a do kolmeia seja mais inteligente, tenha um machine learning bom, algo que funcione e busque o lead da melhor forma possível. tenha as melhores skills de gtm possível".

Já existe: learning loop de 16/11 (`2026-11-16-learning-loop-design.md`): registro do contato em 5 s, rótulo positivo/negativo, proposta semanal de perfil aprovada pelo Juan, pequeno empurrão na ordem. Ele excluiu de propósito "modelo numérico de ML".

### 11.1 Três camadas (ordem de construção)

| Camada | O quê | Funciona quando |
|---|---|---|
| I1 Skills de GTM | Playbooks versionados que a IA carrega: perfil de cliente ideal (ICP), caça por sinal (alvará, obra nova, contratação, nova sede), dossiê da conta, gancho de abertura, cadência ligação→e-mail, objeções, qualificação curta. Fonte: nossas próprias sínteses (`docs/sintese-captacao.md`, `docs/pesquisa-padrao-ouro.md`) e as listas padrão-ouro | Já (só texto + prompts) |
| I2 Provas automáticas (evals) | Cada mudança de skill/prompt/modelo roda contra `data/gold/` (D7) e só entra se a nota subir: acerto de empresa, prova válida, decisor certo, custo por lead | Já |
| I3 Modelo de pontuação (ML) | Modelo numérico simples (regressão logística ou árvores) que estima a chance de reunião por lead, a partir de: tipo, porte, valor e idade do sinal, decisor achado, fonte, cidade, resultado de contatos parecidos. Treina com os rótulos do learning loop **de todos os clientes, só agregado** (base compartilhada = efeito rede, igual Apollo) | Quando houver rótulos suficientes: **?** (proposta: ≥ 200 positivos). Antes disso: pontuação por regra + IA |

### 11.2 Regras
- Skill nova ou modelo novo nunca entra sem passar na I2.
- Modelo explica a nota ("alvará de US$ 1,8M há 12 dias + dono achado"), nunca só um número.
- Nenhum dado de um cliente aparece para outro: o modelo aprende padrões, não entrega leads ou notas de outro workspace.
- Mudança de perfil continua com aprovação humana (learning loop).

### 11.3 Fases
I1 + I2 entram junto com a Fase 0/1. I3 entra na Fase 3, ou antes, se os rótulos chegarem.

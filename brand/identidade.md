# Kolmeia: identidade visual (v0, para aprovar)

## Logo (Favo, aprovado em 16/11/2026)
- **Marca:** três células de favo com cantos suaves. Duas em tinta `#1A1712`, uma em mel `#F5A400`: o lead certo no meio de muitas empresas. Colmeia sem desenho de abelha.
- **Escrita:** `Kolmeia` em Space Grotesk 700, espaçamento -3%; `SOLUTIONS` em Inter 600, caixa alta, espaçamento 36%, cor `#57524A`.
- **Arquivos:**
  - `logo.svg`: marca + nome, fundo claro.
  - `logo-dark.svg`: marca + nome, fundo escuro `#1A1712` (células em `#F4EFE6`).
  - `logo-mark.svg`: só a marca, de 32 px para cima.
  - `logo-mark-small.svg`: só a marca, 24 px ou menos (mais respiro entre as células).
  - `app-icon.svg`: ícone de app e favicon (cópia em `app/src/app/icon.svg`).
- Em produção, converter o texto de `logo.svg` e `logo-dark.svg` em curvas.
- Tamanho mínimo da marca: 16 px (versão reduzida). Área livre em volta: metade da largura da marca.
- Cores e fontes do logo seguem `design-telas/SPEC.md`; as tabelas abaixo são da v0.

## Cores
| Token | Claro | Escuro | Uso |
|---|---|---|---|
| Tinta | `#15171C` | `#ECEAE4` | texto, marca, botão principal, menu lateral |
| Fundo | `#F4F3EF` | `#0F1013` | fundo da página (neutro levemente quente) |
| Superfície | `#FFFFFF` | `#17191D` | cartões, tabelas, painéis |
| Linha | `#E3E0D8` | `#2A2D33` | bordas finas |
| Mel (destaque) | `#E9A21B` | `#F0AE36` | célula do logo, item ativo, respostas no gráfico, "aquecendo" |
| Mel para texto | `#8A5700` | `#F4C262` | texto âmbar sobre fundo claro/escuro |
| OK / Info / Erro | `#23774A` / `#2C5AA0` / `#B3322A` | `#5CC58A` / `#86ACE8` / `#EF8076` | status |

## Fontes (Google Fonts)
- **Geologica**: logo e títulos (geométrica, combina com o hexágono).
- **Onest**: interface (legível em tamanho pequeno, acentos do português bem resolvidos).
- **JetBrains Mono**: números, e-mails, telefones, horários (números alinhados).

## Fazer
- Usar o mel **pouco**: 1 destaque por tela.
- Hexágono só em 3 lugares: avatar, nota de saúde da caixa, estados vazios (e no logo).
- Linhas finas, cantos de 6 px, sem sombra (sombra só em menus e popups).
- Rótulos curtos em português; números sempre em mono.

## Não fazer
- Abelha desenhada, listras amarelo/preto, mel escorrendo.
- Gradiente roxo, creme + serifa + terracota, emoji como marcador.
- Mel como cor de fundo grande ou em vários botões na mesma tela.
- Hexágono como enfeite em botões, fundos ou divisórias.

# Kolmeia app — screen spec (shared by all builders)

Goal: recreate every screen of the Instantly.ai web app (app.instantly.ai) as Kolmeia.ai screens, in Portuguese (pt-BR), with Kolmeia's own design. Same STRUCTURE/FUNCTIONALITY as Instantly, but NOT its look (Instantly is dark/blue; Kolmeia is light cream + honey). Never write "Instantly" anywhere; the product is "Kolmeia" and the AI assistant is "Copiloto Kolmeia".

## Output
Each screen = one file `/home/claude/kol/project/<File>.dc.html` (Design Component format, rules below). Write with the Write tool only. Do not publish anything, do not touch other files.

## Brand tokens (exact)
- Ground (page bg): #FBF8F2 ; surfaces/cards: #FFFFFF ; subtle fill: #F4EFE6 / #F8F5EF / #FCFAF6
- Ink (text): #1A1712 ; secondary text: #57524A ; muted labels: #6A645A (never lighter than this on light bg)
- Borders: #E3DACA (cards), #EFE8DC / #F1EBE0 (row dividers), #D9D0BF (inputs, dashed)
- Accent honey: {{accent}} (prop, default #F5A400); accentSoft = accent + '29' alpha; text on accentSoft: #5C3A00; accent-dark text/eyebrow: #7A4E00. Text ON a honey button is #1A1712.
- Dark surfaces (sidebar): #1A1712 bg, #26221C raised, #3A352C borders, text #F4EFE6, secondary #C9C3B8.
- Success: bg #E6F2EA text #1F5A35. Danger: bg #FBE9E7 text #8A2A1B. Info: bg #E8EEF8 text #23426E.
- Fonts: helmet `<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=Space+Grotesk:wght@500;600;700&amp;display=swap" rel="stylesheet">`. Body Inter; headings (h1,h2,h3, big numbers) 'Space Grotesk'.
- Radii: buttons/inputs 10–12px, cards 16px, pills 999px. Shadow on cards: 0 1px 2px rgba(26,23,18,0.05).
- Logo (hexagon), inline:
  `<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2 L28 9 L28 23 L16 30 L4 23 L4 9 Z" fill="{{accent}}"></path><path d="M16 10 L21.2 13 L21.2 19 L16 22 L10.8 19 L10.8 13 Z" fill="#1A1712"></path></svg>` + "Kolmeia" in Space Grotesk 700.
- Icons: inline stroke SVG (24 viewBox, stroke-width 1.8, round caps), aria-hidden. Never emoji.

## App shell (IDENTICAL on every screen)
Root: `<div style="font-family: Inter, system-ui, sans-serif; color: #1A1712; background: #FBF8F2; min-height: 100vh; display: flex; flex-wrap: wrap; align-items: stretch">`
1. Sidebar `<nav aria-label="Principal">`: `flex: 1 1 232px; max-width: 232px; background: #1A1712; color: #F4EFE6; padding: 20px 12px; box-sizing: border-box; display: flex; flex-direction: column; gap: 4px`. (At phone width it becomes a full-width row: add helmet media query `@media (max-width: 860px){ .k-side{max-width:none !important; flex-basis:100% !important} .k-side .k-navlist{flex-direction:row !important; flex-wrap:wrap} .k-side .k-bottom{display:none !important} }` and class `k-side` on nav, `k-navlist` on the list.)
   - Top: logo + "Kolmeia" (link to Main.dc.html), then workspace pill "Conecta Growth ▾" (#26221C bg).
   - Nav list (each an `<a>` min-height 40px, padding 0 12px, radius 10px, flex gap 12px, icon 18px, font 14px 500, color #C9C3B8, no underline). ACTIVE item: background #26221C, color #FFFFFF, plus a 4px honey dot or honey icon stroke. Items + hrefs, in this order:
     - Copiloto → Copiloto.dc.html (sparkle icon)
     - Busca de leads → BuscaLeads.dc.html (search)
     - Campanhas → Main.dc.html (send/paper-plane)
     - Agentes → Agentes.dc.html (bot/hexagon)
     - CRM → CRM.dc.html (users)
     - Contas de e-mail → ContasEmail.dc.html (mail)
     - Caixa unificada → Unibox.dc.html (inbox)
     - Relatórios → Relatorios.dc.html (bar chart)
   - Bottom block (class k-bottom, margin-top auto): honey-outlined card "Teste grátis · 7 dias restantes" + button "Ver planos"; then user row: avatar circle "JS" honey bg + "Juan" + "Configurações" link (gear).
2. Main column: `flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column`.
   - Top bar: height ~64px, padding 0 32px, border-bottom 1px #EAE3D6, background #FBF8F2, flex wrap, gap 16px: page title (h1, Space Grotesk 22px 700) on left; right side: search input (with `<label>` visually hidden), "Copiloto" button (outline, sparkle icon), notification icon button (aria-label), and for some screens the primary action.
   - Content: padding 28px 32px 48px; `max-width: 1320px; width: 100%; box-sizing: border-box`.

Campaign sub-screens (CampanhaAnalytics/Editor/Leads/Config) keep the sidebar (Campanhas active) but the top bar is: back arrow link to Main.dc.html, campaign name "Prospecção HVAC Boston", tab group (Analytics → CampanhaAnalytics.dc.html, Editor → CampanhaEditor.dc.html, Leads → CampanhaLeads.dc.html, Configurações → CampanhaConfig.dc.html; active tab: ink text + 2px honey underline), status pill "Rascunho", honey button "Lançar".

## Copy & data
- Realistic pt-BR copy, B2B context (Juan's agency prospecting HVAC/construction/clinics in Boston & Brazil). Sample data is OK as clearly illustrative (names like "Marcos Lima", companies like "Clínica Vida", "Neai HVAC"), but don't invent impressive stats: prefer modest realistic numbers or zeros/empty states where Instantly shows them empty. Variables shown as {{primeiro_nome}} must be produced via renderVals strings (brace: '{{', braceEnd: '}}') since {{ }} is template syntax.
- Every screen includes a collapsed hint of the Copiloto (button in top bar). Copiloto.dc.html is the full-page version.

## Format rules (MUST — failures are silent)
Skeleton:
```html
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Kolmeia — Campanhas</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link ...fonts...>
<style>
body{margin:0;background:#FBF8F2}
a{color:#1A1712}a:hover{color:#7A4E00}
h1,h2,h3{font-family:'Space Grotesk',Inter,system-ui,sans-serif}
...
</style>
</helmet>
<div ...root...> ... </div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"accent":{"editor":"color","default":"#F5A400","options":["#F5A400","#FFB81C","#E8950C"],"section":"Tema"},"$preview":{"width":1440,"height":1000}}'>
class Component extends DCLogic {
  renderVals() {
    const accent = this.props.accent ?? '#F5A400';
    const soft = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent + '29' : 'rgba(245,164,0,0.16)';
    return { accent: accent, accentSoft: soft, brace: '{{', braceEnd: '}}' };
  }
}
</script>
</body>
</html>
```
- Keep `<script src="./support.js"></script>` EXACTLY. Close every non-void element; quote every attribute.
- `{{hole}}` = dotted lookup into renderVals() only, never an expression.
- All UI is markup (no innerHTML/appendChild). Repeats: `<sc-for list="{{rows}}" as="r" hint-placeholder-count="5">…{{r.name}}…</sc-for>`; branches `<sc-if value="{{x}}" hint-placeholder-val="{{ true }}">`. Events: `onClick="{{fn}}"` with fn from renderVals. Per-item handlers attached in renderVals.
- Fluid layout (it's a PAGE): no fixed px width on root; use flex/grid with gap, % / fr, max-width containers. Wide tables inside `<div style="overflow-x: auto">`. Toolbars `flex-wrap: wrap`.
- Inline `style="..."` for element styles; helmet `<style>` only for basics, hover states and media queries.
- Accessibility: real `<button type="button">`, `<a href>`, `<input>` with `<label>`; aria-label on icon-only buttons; decorative svg aria-hidden="true". Touch targets ≥ 40px. Text contrast ≥ 4.5:1.
- No emoji, no lorem ipsum, no gradients washes, no left-border accent cards, no iframes, no external images.
- Navigation links between screens are plain `<a href="X.dc.html">` styled as buttons (no <button> inside <a>).
- data-props attribute single-quoted; inside JSON use only plain characters (no apostrophes).
- Aim for rich, complete screens (~250–450 lines each). Add a little interactivity where natural (tabs, filter pills, toggles via state).

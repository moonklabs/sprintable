# Design System, Sprintable

Last updated: 2026-04-25

## Product Context

- **What this is:** Sprintable is a memo-first delegation system for human and AI teams. Work starts as plain-language memos, moves through webhooks and MCP, and stays traceable in one thread.
- **Who it is for:** founders, product teams, service teams, and agent-powered teams that need work handoffs without turning every idea into a ticket tree first.
- **Product type:** authenticated SaaS web app plus OSS self-hosted app, with a marketing surface, dashboard, kanban board, docs editor, memos, settings, and agent operations screens.
- **The thing people should remember:** this feels like a serious command center where humans and agents hand off work without losing context.

## Current Design Audit

### What already exists

- **Token base:** Tailwind 4, shadcn tokens, and CSS custom properties are already wired in `apps/web/src/app/globals.css`.
- **Color model:** the product app uses OKLCH zinc neutrals, a blue brand token, semantic success/warning/info/priority tokens, and separate dark-mode values.
- **Typography:** the app currently loads Inter for sans text, Geist Mono for code/data, and Source Serif 4 for serif moments in `apps/web/src/app/layout.tsx`.
- **UI primitives:** Button, Badge, Card, SectionCard, GlassPanel, Input, PageHeader, EmptyState, and Sidebar primitives exist under `apps/web/src/components/ui`.
- **Shell:** authenticated product surfaces use a left sidebar plus top bar shell through `DashboardShell`, `AppSidebar`, and `TopBar`.
- **Marketing:** the landing page has a separate dark cinematic treatment with hardcoded colors, radial glows, rounded cards, and blue/cyan accents.
- **Brand mark:** the Sprintable mark uses warm yellow/orange layers, while most product UI uses cool blue as the main accent.

### Current diagnosis

The product has the pieces of a system, but it is not one system yet.

The app is calm, tokenized, and shadcn-like. The landing page is darker, more cinematic, and mostly hardcoded. The logo is warm and optimistic. The app accent is cool blue. Those can work together, but right now they read like three partial identities instead of one brand.

The best direction is not to make Sprintable more decorative. The product already has complex objects: memos, boards, docs, agents, workflows, runs, settings, audit logs. Decoration should help users understand state and motion. It should not become another thing to parse.

## Aesthetic Direction

- **Direction:** Industrial command center with editorial clarity.
- **Decoration level:** intentional, not expressive.
- **Mood:** calm, sharp, operational, trustworthy. The product should feel like work is moving through a clear control room, not like a generic SaaS brochure.
- **Category posture:** readable enough for project management, technical enough for agent operations, warmer than a developer console.

### Safe choices

These should stay because users expect them in a work system:

1. **Left navigation plus content shell.** Keep the sidebar for product areas and a simple top bar for page-level controls.
2. **Neutral surfaces.** Keep zinc-like neutrals, light/dark modes, and subtle borders. Users need long-session comfort.
3. **Status badges.** Keep compact semantic status labels for story, memo, agent, and run states.
4. **Card-based grouping.** Keep cards for separable objects, but make card density more consistent.

### Design risks worth taking

These are where Sprintable gets a face:

1. **Use warm amber only for human attention and priority.** The logo is already amber/orange. Use that warmth for priority, deadlines, human approval, and handoff tension. Do not use amber as a general CTA color.
2. **Use electric blue for agent activity and routing.** Blue should mean system motion: webhook sent, agent running, MCP connected, workflow route active.
3. **Add an operational rail language.** Use thin rails, timeline connectors, step numbers, small caps labels, and mono metadata to make work movement visible.
4. **Move away from Inter as the long-term primary font.** Inter is serviceable, but it makes the app look like everything else. Use it until the migration is planned, then move the product UI to Geist or Instrument Sans.

## Typography

### Current

- **Sans:** Inter, loaded as `--font-sans`.
- **Mono:** Geist Mono, loaded as `--font-mono`.
- **Serif:** Source Serif 4, loaded as `--font-serif`.

### Direction

- **Display/Hero:** Satoshi or Geist, 700 to 900 weight, tight tracking.
- **Body:** Geist or Instrument Sans, 400 to 600 weight.
- **UI/Labels:** same as body, with small caps only for section labels and metadata.
- **Data/Tables:** Geist Mono for IDs, API keys, timestamps, run IDs, token counts, and webhook payload labels.
- **Editorial/Marketing accent:** Source Serif 4 may be used sparingly for quotes or manifesto-style copy, not for app navigation or dense UI.
- **Code:** Geist Mono.

### Type scale

Use the existing utility direction in `globals.css` as the base:

| Role | Size | Weight | Tracking | Line height |
|---|---:|---:|---:|---:|
| Display | 32px | 600 to 800 | -0.03em | 1.1 |
| Page H1 | 24px | 600 to 700 | -0.02em | 1.2 |
| Section H2 | 20px | 600 | -0.01em | 1.3 |
| Card title | 16px | 500 to 600 | 0 | 1.4 |
| Body | 14px | 400 | 0 | 1.6 |
| Small | 12px | 400 to 500 | 0 | 1.5 |
| Label | 11px | 600 | 0.08em to 0.16em | 1.2 |
| Mono metadata | 13px | 400 to 500 | -0.01em | 1.4 |

## Color

### Approach

Balanced. Neutrals carry the product. Blue communicates system motion. Amber communicates human attention. Semantic colors communicate state.

### Core palette

Keep implementation in OKLCH tokens. Use these roles consistently:

| Token | Current source | Role |
|---|---|---|
| `--background` | `oklch(1 0 0)` light, `oklch(0.18 0.005 285.823)` dark | Main app canvas |
| `--foreground` | zinc near-black/light | Primary text |
| `--card` | white/light panel or dark raised panel | Object containers |
| `--border` | low-chroma zinc | Separation, not decoration |
| `--brand` | `oklch(0.66 0.18 258)` light, `oklch(0.70 0.18 258)` dark | Agent activity, routing, active system state |
| `--priority` | `oklch(0.65 0.18 50)` light, `oklch(0.70 0.18 50)` dark | Human priority, due dates, approvals |
| `--success` | green | Completed or healthy |
| `--warning` | amber/yellow | Risk, waiting, near deadline |
| `--destructive` | red | Failure, revoke, delete |
| `--info` | blue | Informational state |

### Usage rules

- **Primary CTA:** use `--primary` in dense app UI, use `--brand` only when the action means agent/system motion.
- **Danger:** reserve red for destructive or failed states.
- **Priority:** use amber sparingly. It should pull the eye because a human needs to care.
- **Marketing:** replace hardcoded landing colors with semantic marketing tokens derived from the same palette.
- **Dark mode:** dark surfaces should be redesigned, not inverted. Keep saturation 10 to 20 percent softer on large filled areas.

## Spacing

- **Base unit:** 4px.
- **Density:** compact-comfortable for app screens, spacious for marketing sections.
- **Scale:** 2xs 2px, xs 4px, sm 8px, md 16px, lg 24px, xl 32px, 2xl 48px, 3xl 64px.
- **App page padding:** 24px desktop, 16px tablet/mobile.
- **Card internal padding:** 16px default, 12px compact, 24px for high-level summary cards.
- **Panel gaps:** 16px between panels, 24px between major sections.
- **Lists:** keep row rhythm tight. Most operational rows should sit between 44px and 56px tall.

## Layout

- **Approach:** grid-disciplined product app, hybrid marketing.
- **App shell:** left sidebar plus scrollable content area stays the default.
- **Content width:** app pages can use full available width when data-heavy. Long-form docs and settings forms should cap readable content between 720px and 960px.
- **Breakpoints:** mobile single column, tablet stacked panels, desktop sidebar plus main, wide desktop optional contextual panel.
- **Contextual panels:** keep the `ContextualPanelLayout` pattern for detail panes. It is a good fit for memos, docs, stories, and agent runs.
- **Marketing:** hero sections may use asymmetric layouts, but product screenshots and workflow diagrams should still align to a visible grid.

## Shape, Borders, and Depth

- **Base radius:** keep `--radius: 0.625rem` as the source.
- **Hierarchy:**
  - Small controls: 6px to 8px.
  - Inputs: 10px to 12px.
  - Cards and panels: 16px.
  - Marketing feature cards: 24px to 32px, only when the surrounding layout is spacious.
- **Borders:** default to 1px tokenized borders. Use opacity to reduce noise.
- **Shadows:** keep subtle. Product cards should not look floaty. Use shadow mainly for overlays, drawers, modals, and marketing hero cards.
- **Glass:** allowed for marketing and special operator surfaces. Avoid using glass on every product card.

## Motion

- **Approach:** minimal-functional.
- **Use motion for:** toasts, route-level loading, drawer entry, panel opening, drag/drop feedback, and agent-run state changes.
- **Avoid motion for:** decorative loops, constant background movement, and every card appearing one by one.
- **Durations:** micro 50 to 100ms, short 150 to 250ms, medium 250 to 400ms.
- **Easing:** ease-out for enter, ease-in for exit, ease-in-out for movement.
- **Existing animations:** keep toast slide-in and onboarding enter. Reconsider the entrance spin unless it is tied to a clear brand moment.

## Component Rules

### Buttons

- Default app button should remain compact and rectangular with a small radius.
- Use full pill buttons only in marketing or tag/chip contexts.
- Use `hero` or brand-like buttons only for high-intent actions.
- Destructive buttons should stay low-fill until the user enters a destructive flow.

### Cards

- Use `Card` for repeated object containers.
- Use `SectionCard` for page sections with header/body structure.
- Use `GlassPanel` only for elevated or over-background surfaces.
- Do not mix `rounded-md`, `rounded-xl`, `rounded-2xl`, and `rounded-3xl` in one local cluster without a hierarchy reason.

### Badges

- Status badges should be semantic and compact.
- `success` means done or healthy.
- `info` means running, active, routing, or system movement.
- `outline` means queued, draft, unread, or low-certainty.
- `destructive` means failed, blocked, revoked, or dangerous.

### Empty and loading states

- Empty states should explain the next useful action.
- Skeletons should use tokens, not raw gray classes, so they work in dark mode.
- Product pages should never show a blank white area while loading.

## Marketing Surface Direction

The landing page should become the expressive version of the app, not a separate brand.

Keep:

- dark command-center mood,
- high-contrast hero typography,
- workflow preview card,
- blue/cyan system-motion accents.

Change:

- replace hardcoded hex values with marketing tokens,
- reduce generic glow usage,
- add more product-specific handoff diagrams,
- use amber for human approval or priority moments,
- make the hero feel like a real work handoff, not a generic AI SaaS hero.

## App Surface Direction

The authenticated app should feel like a daily operating room.

Priorities:

1. **Make handoffs visible.** Memos, agent runs, webhooks, replies, and status changes should read as a chain of custody.
2. **Make state obvious.** Every object should answer: what is it, who owns it, what changed, what needs attention, what happens next.
3. **Make density intentional.** Boards and lists can be compact. Detail pages and docs can breathe.
4. **Make agents feel first-class.** Agent runs, HITL approvals, workflows, and MCP tools should have a shared visual grammar.

## Implementation Priorities

1. **Tokenize the landing page.** Move the hardcoded landing colors into named CSS variables or a small marketing token map.
2. **Unify brand accent semantics.** Blue means system motion. Amber means human attention or priority.
3. **Fix skeleton dark mode.** Replace raw gray skeleton colors with tokenized muted colors.
4. **Normalize radius usage.** Audit pages with heavy `rounded-2xl` and `rounded-3xl` use. Keep hierarchy, remove accidental bubbles.
5. **Create workflow/timeline primitives.** Add reusable components for handoff chains, run timelines, memo threads, and agent activity.
6. **Plan a font migration.** Move away from Inter only when ready to touch layout QA, because font metrics will shift spacing.
7. **Write visual QA checks.** For each major surface, verify light mode, dark mode, mobile, empty state, loading state, and long-content state.

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-25 | Initial design system written | Created from the current Sprintable codebase and design consultation audit. |
| 2026-04-25 | Direction set to industrial command center with editorial clarity | Sprintable needs to show human-agent handoffs clearly, not add decoration for its own sake. |
| 2026-04-25 | Blue means system motion, amber means human attention | This reconciles the current cool app accent with the warm Sprintable logo. |
| 2026-04-25 | App stays grid-disciplined, marketing becomes hybrid | Daily work screens need clarity. Marketing still needs a memorable face. |

# Design System — Sprintable

## Product Context
- **What this is:** An intelligence workspace & PM tool
- **Who it's for:** Product teams, developers, and AI agents
- **Project type:** Dashboard / Web App

## Aesthetic Direction: "Human Grid vs AI Glow"
- **Dual Aesthetic:** The system contrasts the rigid, utilitarian world of human work with the dynamic, "alive" presence of AI agents.
- **Human Grid (The Foundation):** Highly dense, utilitarian, Vercel/Linear-style grid system. Black/white, 1px borders, compact spacing, shallow shadows. "Developer-grade" precision.
- **AI Glow (The Activity):** When an AI Agent touches a task or is actively working, it receives an "AI Glow". Animated gradient borders, subtle glows, and specific accent colors (cyan/purple) to show the system is "alive".

## Typography
- **Display/Hero:** Geist
- **Body:** Geist
- **Data/Tags/Meta:** Geist Mono — used for ticket IDs, status, dates, agent logs
- **Loading:** next/font (Google Fonts)

## Color & Visuals
- **Human Elements (Restrained, High Contrast):**
  - Background: Very clean white/black (`#ffffff`, `#000000`, `bg-white`, `bg-black`)
  - Card/Surface: Slightly offset from background (`bg-zinc-50`, `bg-zinc-900`)
  - Border: Subtle, low-contrast 1px lines (`border-zinc-200`, `border-zinc-800`)
  - Text: High contrast primary (`text-zinc-900`, `text-zinc-50`), muted secondary (`text-zinc-500`)
  - Status: blue (feature), red (bug)
- **AI Elements (Dynamic, Glowing):**
  - Accents: Cyan (`cyan-400`/`cyan-500`) and Purple (`purple-400`/`purple-500`)
  - Borders: Animated gradient borders (e.g., `bg-gradient-to-r from-cyan-500 to-purple-500`)
  - Glows: Subtle box shadows (`shadow-[0_0_15px_rgba(6,182,212,0.5)]` or `shadow-cyan-500/50`)
  - Status: Green for active agent, enhanced with a pulse or glow effect.

## Spacing & Density
- **Density:** Compact
- **Padding:** Tighter than default (e.g., `p-3` for cards, `px-2 py-1` for tags)
- **Text Size:** `text-sm` as the primary body size, `text-xs` for metadata

## Layout
- **Approach:** Grid-disciplined
- **Border Radius:** `md` (6-8px) for cards, `sm` (4px) for inner elements. Avoid large pill shapes.

## Motion
- **Human Elements:** Fast, snappy hover states. Minimal-functional.
- **AI Elements:** Fluid, continuous animations. Subtle active/ping animations, rotating gradient borders, or breathing glows for agent status.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| $(date +%Y-%m-%d) | Initial design system created | Adopted Vercel-like utilitarian aesthetic for Agent System feel |
| 2024-04-19 | Added "Human Grid vs AI Glow" | Differentiate human tasks (rigid/dense) from AI activity (dynamic/glowing) |

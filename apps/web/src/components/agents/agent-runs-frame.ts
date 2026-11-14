// 4911 follow-up — the body margin of the agent-run screens (the list and the detail), named ONCE so both draw the same left edge: 16px at the sides (the list's filter bar uses the same
// 16px), 12px above and below. Before this the detail's outermost box had no side margin: its card and the «도구 호출» panel sat flush against the edge of the page panel (x≈313 at 1440)
// while the list's panels, the filter bar and the tabs stood 16px in (x≈329) — on a phone the card touched both screen edges and its rounded corners were cut.
// The list keeps these classes literally on its scroll box (verify:focus-inset-coverage reads the padding off that string); a test pins that the two are the same value.
export const AGENT_RUNS_BODY_FRAME = 'px-4 py-3';

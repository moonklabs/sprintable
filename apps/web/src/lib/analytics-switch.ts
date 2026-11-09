// story 4822 — the one switch that turns the usage-record tag (Google Analytics, components/google-analytics.tsx) off at run time.
//
// The measurement id is baked into the web build (NEXT_PUBLIC_GA4_MEASUREMENT_ID, apps/web/Dockerfile): a build without it never loads the tag.
// A build WITH it (the hosted site's) used to have no way to stop sending short of a rebuild. `DISABLE_ANALYTICS` is read by the server on every
// request (analytics-gate.tsx): when it says «off», the page is sent without the tag — no script, no `gtag`, no request to Google.
//
// The direction is the safe one for a privacy switch: anything that is set and is not an explicit «no» turns the tag off, so a typo
// (`DISABLE_ANALYTICS=ture`) stops the sending instead of silently leaving it on. Only unset, empty or an explicit false word keep it as built.
// Read: docs/usage-records-and-permission-switches.md.
export const ANALYTICS_SWITCH_ENV = 'DISABLE_ANALYTICS';

const EXPLICIT_NO = new Set(['0', 'false', 'no', 'off', 'n']);

export function analyticsDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env[ANALYTICS_SWITCH_ENV] ?? '').trim().toLowerCase();
  return raw !== '' && !EXPLICIT_NO.has(raw);
}

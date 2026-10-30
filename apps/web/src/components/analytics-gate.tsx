// story 4822 — the only place that mounts the usage-record tag. A server component: it asks the switch (lib/analytics-switch.ts) on every
// request and sends the page without the tag when the switch says off. `connection()` is redundant TODAY (the root layout already reads cookies and headers
// for the locale, so every request is dynamic) and stays on purpose: if that ever changes, the answer must not freeze at build time and leave a privacy switch
// silently doing nothing (the review of this change said the same and found no cost).
import { connection } from 'next/server';
import { GoogleAnalytics } from '@/components/google-analytics';
import { analyticsDisabled } from '@/lib/analytics-switch';

export async function AnalyticsGate() {
  await connection();
  return analyticsDisabled() ? null : <GoogleAnalytics />;
}

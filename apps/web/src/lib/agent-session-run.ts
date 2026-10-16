import { EFFORT_LABEL_KEYS } from '@/lib/agent-run-profile';

/**
 * story 4686 (AC2 · Yuna run-info-1014 §1) — what a session really runs on, as the server tells it (`run` on GET /api/agents/{id}/desktop-session):
 * `model` the model that ran (the transcript's, else the profile's) · `model_set` whether the profile NAMED one (false = the runtime's own
 * default ran — the 10-13 case) · `effort` the profile's thinking depth (absent = the default) · `account` a label the daemon already made
 * safe (a masked address or an organisation name + a plan word — shown as received, never built here).
 * One table for every place: the words are the run settings screen's own (namespace `agents`, `runProfile*`).
 */
export interface SessionRun {
  model?: string | null;
  model_set?: boolean | null;
  effort?: string | null;
  account?: string | null;
}

/** the namespace-`agents` translator (a plain key → text function; the callers pass `useTranslations('agents')`) */
type Ta = (key: string) => string;

/** The model as shown: the model that ran (+ «· 런타임 기본값» when the profile did not name it) — or the runtime's default when none is known. */
export function runModelText(run: SessionRun, ta: Ta): string {
  const model = run.model ?? null;
  if (model === null) return ta('runProfileModelDefault');
  return run.model_set === false ? `${model} · ${ta('runProfileModelDefault')}` : model;
}

/** The thinking depth in the settings screen's words, «기본값» when none was given. A word this page does not know (a newer daemon's) is NOT
 *  shown as «기본값» — that would call a non-default value the default: null, and the line leaves that part out (Yuna 506). */
export function runEffortText(effort: string | null | undefined, ta: Ta): string | null {
  if (effort === null || effort === undefined) return ta('runProfileEffortDefault');
  const key = EFFORT_LABEL_KEYS[effort];
  return key ? ta(key) : null;
}

/** «{model} · 생각 깊이 {effort}» — the part the account does not belong to (the detail page's «지금 도는 것» line). */
export function runNowText(run: SessionRun, ta: Ta): string {
  const depth = runEffortText(run.effort, ta);
  return [runModelText(run, ta), ...(depth === null ? [] : [`${ta('runProfileEffort')} ${depth}`])].join(' · ');
}

/** «{model} · 생각 깊이 {effort} · {account}» — the strip's line (and the desktop board's); no account → no tail. */
export function runInfoLine(run: SessionRun, ta: Ta): string {
  return [runNowText(run, ta), ...(run.account ? [run.account] : [])].join(' · ');
}

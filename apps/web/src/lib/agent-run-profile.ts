/**
 * story #4540 (E-DESKTOP-2 C-5) — the runtime · model · effort a desktop agent starts with (contract 20764ba3 v1.1 · 명세 모음 C-5).
 * The server holds the measured table and judges every save; this file only keeps the pickers to what that table offers, so a
 * person isn't shown a value the server would refuse. A change is used from the next start — the web never restarts anything
 * (restarting one by one is the desktop app's · PO ⓓ).
 */
export const DESKTOP_RUNTIMES = ['claude-code', 'codex'] as const;
export type DesktopRuntime = (typeof DESKTOP_RUNTIMES)[number];

/** Low → high, the order every effort list is shown in (유나 2026-10-03). */
export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

export interface RuntimeOptions {
  runtime: DesktopRuntime;
  models: { name: string; efforts: string[] }[];
  custom_model_efforts: string[];
  /** story 4540: this runtime's own model-name rule (Claude may end with «[1m]») — absent from an older server */
  model_pattern?: string;
}

export interface RunProfileOptions {
  runtimes: RuntimeOptions[];
  model_pattern: string;
}

export interface RunProfile {
  agent_id: string;
  runtime: string | null;
  model: string | null;
  effort: string | null;
  version: number;
  updated_at: string | null;
  can_change?: boolean;
  /** story #4580: the hosts this agent may connect to without asking (absent from an older server) */
  allowed_hosts?: { host: string; added_at: string | null }[];
}

export function isDesktopRuntime(runtime: string | null | undefined): runtime is DesktopRuntime {
  return runtime === 'claude-code' || runtime === 'codex';
}

function runtimeOptions(options: RunProfileOptions, runtime: string): RuntimeOptions | undefined {
  return options.runtimes.find((r) => r.runtime === runtime);
}

export function knownModels(options: RunProfileOptions, runtime: string): string[] {
  return runtimeOptions(options, runtime)?.models.map((m) => m.name) ?? [];
}

/** The efforts that runtime · model takes: a listed model's own list, else (typed-in or the runtime's default) the shared one. */
export function effortsFor(options: RunProfileOptions, runtime: string, model: string | null): string[] {
  const rt = runtimeOptions(options, runtime);
  if (!rt) return [];
  const listed = model === null ? undefined : rt.models.find((m) => m.name === model);
  const efforts = listed ? listed.efforts : rt.custom_model_efforts;
  return [...efforts].sort((a, b) => EFFORT_ORDER.indexOf(a as never) - EFFORT_ORDER.indexOf(b as never));
}

/** After the model changes: an effort the new model doesn't take goes back to the default (the server would refuse it). */
export function keepEffortIfTaken(efforts: string[], effort: string | null): string | null {
  return effort !== null && efforts.includes(effort) ? effort : null;
}

/** A typed-in name in the server's shape for that runtime (it goes on a command line) — the server checks again. A runtime not known
 *  (bulk «그대로 두기») takes the strictest shape, the one with no tail. */
export function modelNameOk(options: RunProfileOptions, name: string, runtime?: string | null): boolean {
  const own = runtime ? runtimeOptions(options, runtime)?.model_pattern : undefined;
  return new RegExp(own ?? options.model_pattern).test(name);
}

/** Many agents: model · effort only among one runtime (the names differ · 명세 C-5 일괄). */
export function sharedRuntime(runtimes: (string | null | undefined)[]): string | null {
  const set = new Set(runtimes.map((r) => r ?? ''));
  return set.size === 1 ? [...set][0] || null : null;
}

/** The i18n key (namespace `agents`) for each effort value. */
export const EFFORT_LABEL_KEYS: Record<string, string> = {
  low: 'runProfileEffortLow',
  medium: 'runProfileEffortMedium',
  high: 'runProfileEffortHigh',
  xhigh: 'runProfileEffortXhigh',
  max: 'runProfileEffortMax',
  ultra: 'runProfileEffortUltra',
};

/** The server's refusal codes → the line shown under the fields (namespace `agents`). */
export const SAVE_ERROR_KEYS: Record<string, string> = {
  forbidden: 'runProfileErrorForbidden',
  invalid_model: 'runProfileErrorModel',
  invalid_effort: 'runProfileErrorEffort',
  mixed_runtime: 'runProfileErrorMixed',
  other: 'runProfileErrorGeneric',
};

export function saveErrorKey(status: number, code: string | undefined): string {
  if (status === 403) return SAVE_ERROR_KEYS.forbidden;
  if (code === 'invalid_model' || code === 'invalid_effort' || code === 'mixed_runtime') return SAVE_ERROR_KEYS[code];
  return SAVE_ERROR_KEYS.other;
}

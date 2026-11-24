/**
 * story 5008 (A1 · plan 796e269f) — the desktop runtimes, in ONE module of the web.
 *
 * The server keeps the registry (`backend/app/services/agent_runtime.py` · DESKTOP_RUNTIME_REGISTRY); this file carries the same names so TypeScript can
 * type them, and `backend/tests/test_5008_runtime_registry.py` turns red when the two lists differ. The lists the web used to spell out
 * («claude · codex» in six files) read from here.
 *
 * ENABLED = what an app is offered today (the registry's `enabled` rows). The names after them are allowed in the server's tables and nothing else: a name the
 * web does not know yet is shown by its own text, never an error (see `labelOf`).
 */
export const DESKTOP_RUNTIME_IDS = ['claude', 'codex', 'opencode', 'gemini', 'cursor'] as const;
export type DesktopRuntimeId = (typeof DESKTOP_RUNTIME_IDS)[number];

/** The runtimes an app is offered today — switched on by the registry's `enabled` mark; the web does not decide this. */
export const ENABLED_DESKTOP_RUNTIME_IDS = ['claude', 'codex', 'opencode'] as const satisfies readonly DesktopRuntimeId[];
export type EnabledDesktopRuntimeId = (typeof ENABLED_DESKTOP_RUNTIME_IDS)[number];

/**
 * story 5009 (A2): the runtimes the by-hand «고급 연결» (a key + one pasted line per CLI) has words for — Claude Code and Codex. It is NOT the enabled list: OpenCode is offered through
 * the app's setup, and a manual line for it (its own config file and key place) is a separate piece of work — a chip for it here would read as Codex's text.
 */
export const MANUAL_CONNECT_RUNTIME_IDS = ['claude', 'codex'] as const satisfies readonly EnabledDesktopRuntimeId[];
export type ManualConnectRuntimeId = (typeof MANUAL_CONNECT_RUNTIME_IDS)[number];

/** id → the members.runtime_type value the product uses (the server's DESKTOP_RUNTIME_TYPES, enabled rows). */
export const MEMBER_RUNTIME_TYPE: Record<EnabledDesktopRuntimeId, string> = { claude: 'claude-code', codex: 'codex', opencode: 'opencode' };
export const ENABLED_MEMBER_RUNTIME_TYPES = ENABLED_DESKTOP_RUNTIME_IDS.map((id) => MEMBER_RUNTIME_TYPE[id]) as readonly string[];

/** A value that came over the wire: is it a runtime this web build can act on? (anything else is kept as text and shown as unsupported). */
export function isEnabledRuntimeId(value: unknown): value is EnabledDesktopRuntimeId {
  return typeof value === 'string' && (ENABLED_DESKTOP_RUNTIME_IDS as readonly string[]).includes(value);
}

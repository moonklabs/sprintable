/**
 * story 4766 — the one line a person pastes in a terminal to connect an agent they already run, without the Mac app.
 *
 * What the line does (Claude Code): `claude mcp add` registers the hosted MCP server for this folder-less «local» scope, and `&&` then opens
 * Claude Code with the verification sentence as its first message — so one paste connects and asks for the first tool call. Claude Code
 * itself still asks the person whether it may use the tool: the product decides nothing about the agent's permissions.
 *
 * Where the key stays (Kadir's lens · measured on claude 2.1.310 / codex 0.160.1): the line holds the key, so the shell's history, the
 * clipboard and — for Claude Code — `~/.claude.json` (0600, plaintext) keep it, and `ps` shows it for the command's lifetime. Hence:
 *  - `--scope local` is written out and `--scope project` never is (project scope writes `.mcp.json` in the repo folder, 0644 — a commit away);
 *  - no «put a space before it» advice anywhere (it records anyway by default in zsh and bash);
 *  - the screen shows the key masked, once, and the clipboard line is the only place it is copied from.
 */

/** the name the server is registered under — the same as the `.mcp.json` the connection artifact carries (not the channel plugin's `sprintable`) */
export const MCP_SERVER_NAME = 'sprintable-mcp';

/** the environment variable the Codex line puts the key in (Codex reads the bearer token from the environment, never from its file) */
export const CODEX_KEY_ENV = 'SPRINTABLE_AGENT_KEY';

export type ConnectRuntime = 'claude' | 'codex';

/** the key as the screen shows it: the prefix that says what it is and the last four, nothing between */
export function maskKey(key: string): string {
  const prefix = key.startsWith('sk_live_') ? 'sk_live_' : '';
  return `${prefix}••••${key.slice(-4)}`;
}

/** a value the shell takes literally: single-quoted, a single quote inside closed and reopened */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** the first message the agent opens with — the same sentence the connection screen has always suggested (an ordinary read-only ask).
 *  One line whatever a translator typed: a newline in it would split the pasted command in two. */
function firstMessage(sentence: string): string {
  return shellQuote(sentence.replace(/[\r\n]+/g, ' ').trim());
}

/** A key the shell line can carry as plain characters: what the server issues (`sk_live_` + URL-safe characters). Anything else is not put
 *  on a command line at all (the press says «키를 받지 못했어요» instead of building a line from something odd). */
export function isPlainKey(key: unknown): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9_.~+/=-]{8,200}$/.test(key);
}

export interface ConnectLineInput {
  runtime: ConnectRuntime;
  /** the hosted MCP address (from the connection artifact — never built in the browser) */
  mcpUrl: string;
  /** the agent's key, plain — only ever passed in to build the line that is copied; `masked: true` swaps it for `maskKey` */
  key: string;
  /** the sentence the agent opens with (the app's `verifyExamplePrompt`) */
  sentence: string;
  masked?: boolean;
}

/** The pasted line(s) for the runtime. Claude Code: one line. Codex: the key goes in an environment variable first (its CLI takes the
 *  bearer token from the environment) — two lines joined by `&&`, so it still pastes as one command and the variable lives in that shell. */
export function buildConnectLine({ runtime, mcpUrl, key, sentence, masked = false }: ConnectLineInput): string {
  const shownKey = masked ? maskKey(key) : key;
  if (runtime === 'claude') {
    // single-quoted whole (the shell takes it literally): a `$`, a backtick or a double quote in a key could never run or end the argument
    const header = shellQuote(`Authorization: Bearer ${shownKey}`);
    return `claude mcp add --transport http --scope local ${MCP_SERVER_NAME} ${mcpUrl} --header ${header} && claude ${firstMessage(sentence)}`;
  }
  return `export ${CODEX_KEY_ENV}=${shellQuote(shownKey)} && codex mcp add ${MCP_SERVER_NAME} --url ${mcpUrl} --bearer-token-env-var ${CODEX_KEY_ENV} && codex ${firstMessage(sentence)}`;
}

/** The hosted MCP address out of the connection artifact's `.mcp.json` content — null when it is not there (never guessed). */
export function mcpUrlFromArtifact(content: string | null | undefined): string | null {
  if (!content) return null;
  try {
    const server = (JSON.parse(content) as { mcpServers?: Record<string, { url?: unknown }> }).mcpServers?.[MCP_SERVER_NAME];
    const url = server?.url;
    // host and a plain path only — no query, no shell-special character (this text ends up on a command line)
    return typeof url === 'string' && /^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~%/-]*)?$/.test(url) ? url : null;
  } catch {
    return null;
  }
}

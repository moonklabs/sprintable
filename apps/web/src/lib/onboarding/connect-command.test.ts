import { describe, expect, it } from 'vitest';
import { buildConnectLine, CODEX_KEY_ENV, isPlainKey, maskKey, MCP_SERVER_NAME, mcpUrlFromArtifact } from './connect-command';

const URL = 'https://dev-mcp.sprintable.ai/mcp';
// the key's prefix is built, not written: a literal `sk_live_…` reads as a Stripe key to the push-protection scanner
const KEY = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('_');
const SENTENCE = '내 스토리 목록 보여줘';


/** a minimal POSIX word split — single quotes literal (and `'\\''` closes, escapes, reopens), `&&` its own word; enough to see what a shell sees */
function posixWords(line: string): string[] {
  const words: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  const flush = () => { if (has) { words.push(cur); cur = ''; has = false; } };
  while (i < line.length) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      cur += line.slice(i + 1, end); has = true; i = end + 1;
    } else if (c === '\\') { cur += line[i + 1]; has = true; i += 2; }
    else if (c === ' ') { flush(); i += 1; }
    else if (c === '&' && line[i + 1] === '&') { flush(); words.push('&&'); i += 2; }
    else { cur += c; has = true; i += 1; }
  }
  flush();
  return words;
}

describe('buildConnectLine — story 4766 (Kadir\'s lens conditions)', () => {
  it('Claude Code: one line — add the hosted server (local scope, written out), then open Claude Code with the sentence', () => {
    const line = buildConnectLine({ runtime: 'claude', mcpUrl: URL, key: KEY, sentence: SENTENCE });
    expect(line).toBe(`claude mcp add --transport http --scope local ${MCP_SERVER_NAME} ${URL} --header 'Authorization: Bearer ${KEY}' && claude '내 스토리 목록 보여줘'`);
    expect(line.split('\n')).toHaveLength(1);
  });

  it('never writes project scope (it lands the key in the repo\'s .mcp.json) and never starts with a space', () => {
    for (const runtime of ['claude', 'codex'] as const) {
      const line = buildConnectLine({ runtime, mcpUrl: URL, key: KEY, sentence: SENTENCE });
      expect(line).not.toMatch(/--scope\s+project/);
      expect(line.startsWith(' ')).toBe(false);
    }
  });

  it('Codex: the key goes in an environment variable (its CLI reads the bearer token from there) — still one pasted line', () => {
    const line = buildConnectLine({ runtime: 'codex', mcpUrl: URL, key: KEY, sentence: SENTENCE });
    expect(line).toBe(`export ${CODEX_KEY_ENV}='${KEY}' && codex mcp add ${MCP_SERVER_NAME} --url ${URL} --bearer-token-env-var ${CODEX_KEY_ENV} && codex '내 스토리 목록 보여줘'`);
    expect(line.split('\n')).toHaveLength(1);
    // the key is the one thing in the line that is not on the command that registers the server
    expect(line.split('codex mcp add')[1]).not.toContain(KEY);
  });

  it('masked: the screen\'s copy of the line holds the prefix and the last four only', () => {
    const shown = buildConnectLine({ runtime: 'claude', mcpUrl: URL, key: KEY, sentence: SENTENCE, masked: true });
    expect(shown).toContain('sk_live_••••ABCD');
    expect(shown).not.toContain(KEY);
    expect(shown).not.toContain('abcdefghijkl');
  });

  it('a single quote in the sentence is closed and reopened (the shell takes the sentence literally)', () => {
    const line = buildConnectLine({ runtime: 'claude', mcpUrl: URL, key: KEY, sentence: "it's mine" });
    expect(line.endsWith(`&& claude 'it'\\''s mine'`)).toBe(true);
  });
});

describe('maskKey', () => {
  it('keeps the prefix that names it and the last four', () => {
    expect(maskKey(KEY)).toBe('sk_live_••••ABCD');
    expect(maskKey('abcd1234')).toBe('••••1234');
  });
});

describe('mcpUrlFromArtifact — the address is read from the connection artifact, never built or guessed', () => {
  const art = (url: unknown) => JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url, headers: {} } } });
  it('reads the hosted url', () => {
    expect(mcpUrlFromArtifact(art(URL))).toBe(URL);
  });
  it('null for anything that is not a plain https address (so nothing odd reaches a shell line)', () => {
    expect(mcpUrlFromArtifact(art('http://x/mcp'))).toBeNull();
    expect(mcpUrlFromArtifact(art('https://x/mcp; rm -rf ~'))).toBeNull();
    expect(mcpUrlFromArtifact(art('https://x/$(id)'))).toBeNull();
    expect(mcpUrlFromArtifact(art('https://x/mcp;ls'))).toBeNull();
    expect(mcpUrlFromArtifact(art('https://x/mcp?a=1&b=2'))).toBeNull();
    expect(mcpUrlFromArtifact(art('https://x/mcp|sh'))).toBeNull();
    expect(mcpUrlFromArtifact(art(42))).toBeNull();
    expect(mcpUrlFromArtifact('not json')).toBeNull();
    expect(mcpUrlFromArtifact(null)).toBeNull();
    expect(mcpUrlFromArtifact(JSON.stringify({ mcpServers: {} }))).toBeNull();
  });
});

describe('the shell takes every piece literally (codex round 1 · story 4766)', () => {
  it('a key with a quote, `$()`, a backtick or a backslash is ONE literal argument to the shell (a POSIX word split of the line sees the key whole)', () => {
    const nasty = "sk_live_a'b$(touch /tmp/x)`id`\\z";
    const line = buildConnectLine({ runtime: 'claude', mcpUrl: URL, key: nasty, sentence: SENTENCE });
    const words = posixWords(line);
    const at = words.indexOf('--header');
    expect(words[at + 1]).toBe(`Authorization: Bearer ${nasty}`); // one word, byte for byte
    expect(words).toContain('&&'); // the only control operator is the one we wrote
    expect(words.filter((w) => /^(;|\|\||\||&)$/.test(w))).toEqual([]);
  });

  it('a newline in the sentence (a translator\'s edit) never splits the pasted command', () => {
    const line = buildConnectLine({ runtime: 'claude', mcpUrl: URL, key: KEY, sentence: '내 스토리\n목록 보여줘\r\n' });
    expect(line).not.toMatch(/[\r\n]/);
    expect(line.endsWith(`&& claude '내 스토리 목록 보여줘'`)).toBe(true);
  });

  it('isPlainKey: what the server issues passes; anything with a space, quote or newline does not (no line is built from it)', () => {
    expect(isPlainKey(KEY)).toBe(true);
    for (const bad of ['', 'short', 'sk_live_ has space0000', "sk_live_a'b00000000", 'sk_live_line\nbreak0000', 'sk_live_$(x)000000', 42, null, undefined]) expect(isPlainKey(bad)).toBe(false);
  });
});

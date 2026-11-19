// story 4981 (PR 4): the usage sheet's data — only the server's closed shape is kept, times are worded in the strip's own buckets.
import { describe, expect, it } from 'vitest';
import { accountOrdinal, agoOf, loadUsage, parseUsage, untilOf, windowName, type UsageRow } from './agent-usage';

const NOW = Date.parse('2026-11-19T06:00:00Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const win = (over: Record<string, unknown> = {}) => ({ kind: 'five_hour', minutes: 300, used_percent: 63, resets_at: iso(2 * 3_600_000), ...over });
const row = (over: Record<string, unknown> = {}) => ({ runtime: 'claude', account: 'a1b2c3d4e5f6', state: 'windows', why: null, windows: [win()], seen_at: iso(-90_000), ...over });
const view = (usage: unknown[], over: Record<string, unknown> = {}) => ({ agent_id: 'x', remote_control: true, setup_id: 's-1', device_name: '작업용 맥북', connected: true, usage, ...over });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('parseUsage — only the closed shape is kept', () => {
  it('a good answer comes through with its words and numbers', () => {
    const v = parseUsage(view([row(), row({ runtime: 'codex', account: 'cccccccccccc', state: 'unavailable', why: 'api_key', windows: [] })]))!;
    expect(v.remoteControl && v.connected && v.hasComputer).toBe(true);
    expect(v.deviceName).toBe('작업용 맥북');
    expect(v.rows.map((r) => [r.runtime, r.state, r.why, r.windows.length])).toEqual([['claude', 'windows', null, 1], ['codex', 'unavailable', 'api_key', 0]]);
    expect(v.rows[0]!.windows[0]).toEqual({ kind: 'five_hour', minutes: 300, usedPercent: 63, resetsAt: iso(2 * 3_600_000) });
  });
  it('a row that does not have the shape is LEFT OUT, never drawn half (a text percent · out of range · a word off the list · no account · bad time)', () => {
    const bad = [
      row({ windows: [win({ used_percent: '63' })] }), row({ windows: [win({ used_percent: 101 })] }), row({ windows: [win({ used_percent: 63.5 })] }), row({ windows: [win({ kind: 'monthly' })] }),
      row({ windows: [] }), row({ windows: [win(), win(), win(), win(), win()] }), row({ runtime: 'gemini' }), row({ account: '/Users/me/.claude' }), row({ seen_at: 'yesterday' }),
      row({ state: 'unavailable', why: 'because', windows: [] }), row({ state: 'other' }), 5, null, 'x',
    ];
    const v = parseUsage(view([...bad, row({ account: 'zzzzzzzzzzzz' })]))!;
    expect(v.rows.map((r) => r.account)).toEqual(['zzzzzzzzzzzz']);
  });
  it('a window time that is not a time is shown as «unknown», not dropped with its number; minutes that are not a positive whole number are none', () => {
    const v = parseUsage(view([row({ windows: [win({ resets_at: 'soon', minutes: -3 })] })]))!;
    expect(v.rows[0]!.windows[0]).toMatchObject({ resetsAt: null, minutes: null, usedPercent: 63 });
  });
  it('an answer that is not the view (no flags · usage not a list · not an object) is null', () => {
    for (const x of [null, 5, 'x', [], {}, { remote_control: true, connected: true }, { remote_control: 'yes', connected: true, usage: [] }, { remote_control: true, connected: true, usage: {} }]) expect(parseUsage(x), JSON.stringify(x)).toBeNull();
  });
  it('a computer-less answer says so (no setup_id) and keeps no rows from nowhere', () => {
    const v = parseUsage(view([], { setup_id: null, device_name: null }))!;
    expect(v.hasComputer).toBe(false); expect(v.deviceName).toBeNull(); expect(v.rows).toEqual([]);
  });
});

describe('loadUsage', () => {
  const deps = (res: () => Promise<Response>) => ({ fetch: async (id: string) => { urls.push(id); return res(); }, now: () => NOW });
  const urls: string[] = [];
  it('asks for the agent and returns the view', async () => {
    urls.length = 0;
    const r = await loadUsage('a-1', deps(async () => json(200, view([row()]))));
    expect(urls).toEqual(['a-1']); expect(r.kind).toBe('ok');
  });
  it('404 · 403 → gone (nothing is shown of an agent the person may not see) · other errors · network error · a body that is not the view → failed', async () => {
    expect((await loadUsage('a', deps(async () => json(404, {})))).kind).toBe('gone');
    expect((await loadUsage('a', deps(async () => json(403, {})))).kind).toBe('gone');
    expect((await loadUsage('a', deps(async () => json(500, {})))).kind).toBe('failed');
    expect((await loadUsage('a', deps(async () => { throw new Error('offline'); }))).kind).toBe('failed');
    expect((await loadUsage('a', deps(async () => json(200, { nope: 1 })))).kind).toBe('failed');
    expect((await loadUsage('a', deps(async () => new Response('not json', { status: 200 })))).kind).toBe('failed');
  });
});

describe('the words of time — the strip\'s own buckets', () => {
  it('«last seen»: under a minute → now · minutes · hours · days (drift up to a minute is «now» · further ahead says nothing)', () => {
    expect(agoOf(iso(-30_000), NOW)).toEqual({ unit: 'now' });
    expect(agoOf(iso(-60_000), NOW)).toEqual({ unit: 'min', n: 1 });
    expect(agoOf(iso(-59 * 60_000), NOW)).toEqual({ unit: 'min', n: 59 });
    expect(agoOf(iso(-60 * 60_000), NOW)).toEqual({ unit: 'hour', n: 1 });
    expect(agoOf(iso(-(24 * 60 - 1) * 60_000), NOW)).toEqual({ unit: 'hour', n: 23 });
    expect(agoOf(iso(-3 * 24 * 3_600_000), NOW)).toEqual({ unit: 'day', n: 3 });
    expect(agoOf(iso(+30_000), NOW)).toEqual({ unit: 'now' });       // up to a minute ahead (clock drift) is «now»
    expect(agoOf(iso(+5 * 60_000), NOW)).toBeNull();                 // further ahead cannot be read — the strip's rule: it says nothing
    expect(agoOf(null, NOW)).toBeNull(); expect(agoOf('soon', NOW)).toBeNull();
  });
  it('«resets in»: past → passed · minutes (at least 1) · hours · days', () => {
    expect(untilOf(iso(-1), NOW)).toEqual({ unit: 'passed' }); expect(untilOf(iso(0), NOW)).toEqual({ unit: 'passed' });
    expect(untilOf(iso(1_000), NOW)).toEqual({ unit: 'min', n: 1 });
    expect(untilOf(iso(59 * 60_000), NOW)).toEqual({ unit: 'min', n: 59 });
    expect(untilOf(iso(60 * 60_000), NOW)).toEqual({ unit: 'hour', n: 1 });
    expect(untilOf(iso(2 * 3_600_000 + 20 * 60_000), NOW)).toEqual({ unit: 'hour', n: 2 });
    expect(untilOf(iso(3 * 24 * 3_600_000), NOW)).toEqual({ unit: 'day', n: 3 });
    expect(untilOf(null, NOW)).toBeNull();
  });
  it('a window\'s name: the two Claude words, else the minutes the CLI gave (minutes · hours · days), else «limit»', () => {
    expect(windowName({ kind: 'five_hour', minutes: 300 })).toEqual({ key: 'five_hour' });
    expect(windowName({ kind: 'seven_day', minutes: 10_080 })).toEqual({ key: 'seven_day' });
    expect(windowName({ kind: 'other', minutes: 45 })).toEqual({ key: 'min', n: 45 });
    expect(windowName({ kind: 'other', minutes: 180 })).toEqual({ key: 'hour', n: 3 });
    expect(windowName({ kind: 'other', minutes: 43_200 })).toEqual({ key: 'day', n: 30 });
    expect(windowName({ kind: 'other', minutes: null })).toEqual({ key: 'unknown' });
  });
  it('an account number is told only when a CLI has more than one (in the given order)', () => {
    const rows = parseUsage(view([row({ account: 'aaaaaaaaaaaa' }), row({ account: 'bbbbbbbbbbbb' }), row({ runtime: 'codex', account: 'cccccccccccc' })]))!.rows as UsageRow[];
    expect(rows.map((r) => accountOrdinal(rows, r))).toEqual([1, 2, null]);
  });
});

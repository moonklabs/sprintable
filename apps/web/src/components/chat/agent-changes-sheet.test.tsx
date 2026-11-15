// @vitest-environment jsdom
//
// story 4951 ①c — the «바뀐 파일» sheet: one row per file (name · numbers · status chip), a hidden file is one plain row with no name, a rename shows both names,
// «more» says there are more, every closed refusal has its sentence in ko AND en, nothing about a file's content is ever drawn, and the list is asked for ONCE per opening.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import type { ChangesDeps } from '@/lib/agent-changes';

vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn() }));
const { AgentChangesSheet } = await import('./agent-changes-sheet');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMMAND = '33333333-4444-4555-8666-777777777777';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const file = (over: Record<string, unknown> = {}) => ({ status: 'modified', name: 'src/a.ts', old_name: null, adds: 12, dels: 3, binary: false, hidden: false, ...over });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

function deps(look: Response[], ask: Response = json(201, { command_id: COMMAND })) {
  const calls: string[] = [];
  const d: ChangesDeps = {
    paths: { ask: (a) => `/api/agents/${a}/desktop-changes`, look: (a, c) => `/api/agents/${a}/desktop-changes/${c}` },
    fetch: async (url, init) => { calls.push(`${init?.method ?? 'GET'} ${url}`); return init?.method === 'POST' ? ask : (look.shift() ?? json(200, { state: 'delivered', files: null })); },
    now: () => 1_000_000,
    sleep: async () => true,
  };
  return { d, calls };
}
async function open(d: ChangesDeps, locale: 'ko' | 'en' = 'ko', device: string | null = 'SYJ-MacBook-Pro') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <AgentChangesSheet agentId="a-1" sessionKey="s-1" deviceName={device} open onOpenChange={() => {}} deps={d} />
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}
const q = (sel: string) => document.body.querySelector(sel);
const rows = () => [...document.body.querySelectorAll('[data-testid="agent-changes-row"]')];

describe('AgentChangesSheet (story 4951 ①c)', () => {
  it('draws one row per file: the name, the numbers, a status chip — a rename shows both names, a binary file says so, a hidden one has no name at all', async () => {
    const { d } = deps([json(200, { state: 'done', code: 'ok', more: false, total: 4, files: [
      file(), file({ status: 'renamed', name: 'docs/new.md', old_name: 'docs/old.md', adds: null, dels: null }), file({ status: 'added', name: 'pic.png', binary: true, adds: null, dels: null }),
      file({ status: 'added', hidden: true, name: null }),
    ] })]);
    await open(d);
    expect(rows()).toHaveLength(4);
    expect(rows()[0]!.textContent).toContain('src/a.ts');
    expect(rows()[0]!.textContent).toContain('＋12 －3');
    expect(rows()[0]!.textContent).toContain('바뀜');
    expect(rows()[1]!.textContent).toContain('docs/old.md → docs/new.md');
    expect(rows()[1]!.textContent).toContain('이름 바뀜');
    expect(rows()[2]!.textContent).toContain('이진 파일');
    expect(rows()[3]!.getAttribute('data-hidden')).toBe('true');
    expect(rows()[3]!.textContent).toContain('가려진 파일 1개');
    expect(rows()[3]!.textContent).toContain('이름도 보내지 않아요');
    expect(q('[data-testid="agent-changes-count"]')!.textContent).toBe('4개');
  });

  it('the list is asked for ONCE per opening: one POST, the looks until it came, and no look after it', async () => {
    const { d, calls } = deps([json(200, { state: 'delivered', files: null }), json(200, { state: 'done', files: [file()], more: false, total: 1 })]);
    await open(d);
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(2);
    expect(rows()).toHaveLength(1);
  });

  it('says there is more when the server cut the list, and says nothing is changed when the list is empty', async () => {
    await open(deps([json(200, { state: 'done', files: [file()], more: true, total: 260 })]).d);
    expect(q('[data-testid="agent-changes-more"]')!.textContent).toContain('모두 260개');
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await open(deps([json(200, { state: 'done', files: [], more: false, total: 0 })]).d);
    expect(q('[data-testid="agent-changes-empty"]')!.textContent).toBe('바뀐 파일이 없어요');
    expect(q('[data-testid="agent-changes-list"]')).toBeNull();
  });

  it('every closed refusal has its sentence in Korean AND English, and a reload button only where a new ask can help', async () => {
    // a Response body can be read once: each refusal is made fresh for every language
    const problems: Array<[() => Response, string, boolean]> = [
      [() => json(403, { error: { code: 'not_allowed_to_read_changes' } }), 'not_allowed', false], [() => json(409, { error: { code: 'device_unreachable' } }), 'unreachable', true],
      [() => json(409, { error: { code: 'changes_busy' } }), 'busy', true], [() => json(409, { error: { code: 'remote_control_off' } }), 'remote_off', false],
    ];
    for (const locale of ['ko', 'en'] as const) {
      for (const [ask, problem, reload] of problems) {
        await act(async () => { root.unmount(); }); root = createRoot(container);
        await open(deps([], ask()).d, locale);
        const el = q('[data-testid="agent-changes-problem"]')!;
        expect(el.getAttribute('data-problem')).toBe(problem);
        expect(el.textContent!.length).toBeGreaterThan(8);
        expect(el.textContent).not.toMatch(/^changes\./); // a missing key would print the key itself
        expect(!!q('[data-testid="agent-changes-reload"]')).toBe(reload);
      }
    }
  });

  it('the computer refusing because the session\'s folder holds the app\'s own data folder (`state_inside`) is said in one plain sentence in ko AND en, with no reload (a new ask would be refused the same way) — never a bare «failed»', async () => {
    for (const locale of ['ko', 'en'] as const) {
      await act(async () => { root.unmount(); }); root = createRoot(container);
      await open(deps([json(200, { state: 'failed', code: 'state_inside', files: null })]).d, locale);
      const el = q('[data-testid="agent-changes-problem"]')!;
      expect(el.getAttribute('data-problem')).toBe('state_inside');
      expect(el.textContent!.length).toBeGreaterThan(20);
      expect(el.textContent).not.toMatch(/^changes\./);
      expect(el.textContent).not.toBe((locale === 'ko' ? koMessages : enMessages).chats.agentSession.changes.problem.failed); // not the generic «failed» sentence
      expect(q('[data-testid="agent-changes-reload"]')).toBeNull();
    }
  });

  it('a 404 after asking offers «다시 불러오기» (not a fault line)', async () => {
    await open(deps([json(404, { error: { code: 'changes_read_not_found' } })]).d);
    expect(q('[data-testid="agent-changes-problem"]')!.getAttribute('data-problem')).toBe('expired');
    expect(q('[data-testid="agent-changes-reload"]')!.textContent).toBe('다시 불러오기');
  });

  it('closing and opening again draws no old list at any moment of the new opening (every node added is watched) and asks once per opening (codex ①c r1 #2 — the render guard itself is not observable here: the Dialog portal mounts its content a render later)', async () => {
    const { d, calls } = deps([json(200, { state: 'done', files: [file({ name: 'OLD-LIST-ROW.ts' })], more: false, total: 1 })]);
    const render = (isOpen: boolean) => act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <AgentChangesSheet agentId="a-1" sessionKey="s-1" deviceName={null} open={isOpen} onOpenChange={() => {}} deps={d} />
        </NextIntlClientProvider>,
      );
    });
    await render(true);
    for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
    expect(rows()).toHaveLength(1);
    await render(false);
    // every node added from here on is recorded: the old row must not come back for a frame, even one the effect replaces a moment later
    const added: string[] = [];
    const seen = new MutationObserver((records) => { for (const r of records) r.addedNodes.forEach((n) => added.push((n as Element).textContent ?? '')); });
    seen.observe(document.body, { childList: true, subtree: true });
    await render(true);
    for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
    added.push(...seen.takeRecords().flatMap((r) => [...r.addedNodes].map((n) => (n as Element).textContent ?? '')));
    seen.disconnect();
    expect(added.join('|')).not.toContain('OLD-LIST-ROW.ts');
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(2); // one ask per opening
  });

  it('draws no file content and no folder path: the only text of a row is its name, its numbers and its status', async () => {
    await open(deps([json(200, { state: 'done', files: [file({ content: 'SECRET BODY', diff: '+x', path: '/Users/me/proj' })], more: false, total: 1 })]).d);
    expect(document.body.textContent).not.toContain('SECRET BODY');
    expect(document.body.textContent).not.toContain('/Users/me/proj');
  });

  it('the lead says which computer, or just «this session\'s folder» when the name is not known — in both languages', async () => {
    await open(deps([json(200, { state: 'done', files: [], more: false, total: 0 })]).d, 'ko', 'SYJ-MacBook-Pro');
    expect(q('[data-testid="agent-changes-lead"]')!.textContent).toContain('SYJ-MacBook-Pro');
    await act(async () => { root.unmount(); }); root = createRoot(container);
    await open(deps([json(200, { state: 'done', files: [], more: false, total: 0 })]).d, 'en', null);
    expect(q('[data-testid="agent-changes-lead"]')!.textContent).toContain('this session');
  });
});

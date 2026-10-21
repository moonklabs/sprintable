// @vitest-environment jsdom
//
// story 4734 (Yuna 4734-pairing-unit-copy-1020.md §A · design 4734-pairing-unit-design-1020.md) — «연결된 기기» is one line per COMPUTER: a Mac with a hundred
// setups is one line; its setups are in the fold; «이 컴퓨터 모두 끊기» asks big and once, then ends every connected setup of it at once; a setup row keeps its own
// «연결 끊기» (with one added sentence when the computer has other setups). Each test names what it pins.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { DesktopDevices } from './desktop-devices';
import { pairedPhoneGap, readComputers, type DesktopComputer } from '@/lib/desktop-computers';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const C1 = 'c1111111-1111-4111-8111-111111111111';
const C2 = 'c2222222-2222-4222-8222-222222222222';
const setup = (n: number, over: Record<string, unknown> = {}) => ({
  setup_id: sid(n), device_name: 'SYJ-MacBook-Pro', state: 'handed_over', confirmed_at: '2026-09-29T10:00:00Z', confirmed_by_name: '김지우', revoked_at: null, revoked_by_name: null,
  active_keys: 1, paired_phones: 1, members: [{ kind: 'agent', member_id: `agent-${n}`, name: `에이전트${n}`, role: 'Dev' }], ...over,
});
const computer = (id: string, name: string, setups: ReturnType<typeof setup>[], over: Record<string, unknown> = {}) => ({
  computer_id: id, device_name: name, state: setups.some((s) => s.state === 'handed_over') ? 'handed_over' : 'disconnected', confirmed_by_name: '김지우',
  confirmed_at: '2026-09-29T10:00:00Z', last_used_at: null, live_setups: setups.filter((s) => s.state === 'handed_over').length, active_keys: setups.length, setups, ...over,
});
const list = (...cs: ReturnType<typeof computer>[]) => JSON.stringify({ computers: cs, truncated: false });
const all = (...cs: unknown[]) => JSON.stringify({ setups_disconnected: cs.length, revoked_keys: 3, already_disconnected: false, revoked_at: '2026-09-30T05:00:00Z', revoked_by_name: '김지우' });

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let listBody: string;

function asAdmin() {
  useDashboardContextMock.mockReturnValue({
    orgId: 'org-1', orgMemberships: [{ orgId: 'org-1', orgName: '뭉클랩', orgSlug: 'moonklabs', role: 'admin' }], projectMemberships: [], userName: '김지우',
  });
}
async function render(locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(<NextIntlClientProvider locale={locale} messages={(locale === 'ko' ? koMessages : enMessages) as never} timeZone="Asia/Seoul"><DesktopDevices /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); });
}
const q = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };
const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); }); };
const deletes = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE').map(([url]) => url as string);

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  asAdmin();
  listBody = list(
    computer(C1, 'SYJ-MacBook-Pro', [setup(1), setup(2), setup(3)]),
    computer(C2, '사무실 맥', [setup(4, { device_name: '사무실 맥' })]),
  );
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(all(1, 2, 3), { status: 200 });
    return new Response(listBody, { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  window.location.hash = '';
});
afterEach(() => { act(() => root.unmount()); container.remove(); document.body.innerHTML = ''; vi.unstubAllGlobals(); window.location.hash = ''; });

describe('[4734 AC3] one line per computer', () => {
  it('a Mac with 100 setups is ONE line; the other Mac is its own; the line says «에이전트 N개 · 설정 N곳» and the name once', async () => {
    listBody = list(computer(C1, 'SYJ-MacBook-Pro', Array.from({ length: 100 }, (_, i) => setup(i + 1))), computer(C2, '사무실 맥', [setup(500, { device_name: '사무실 맥' })]));
    await render();
    expect(q('desktop-computer-row')).toHaveLength(2); // reverted (a line per setup) → 101
    expect(q('desktop-computer-name').map((n) => n.textContent)).toEqual(['SYJ-MacBook-Pro', '사무실 맥']);
    expect(q('desktop-computer-meta')[0].textContent).toMatch(/^에이전트 100개 · 설정 100곳 · \d+월 \d+일 연결 · 연결한 사람 김지우$/);
    expect(q('desktop-device-row')).toHaveLength(101); // the setups are inside the folds, not in the list
    expect(container.textContent).not.toContain('뭉클랩');
  });

  it('the fold: «설정 보기» (closed) / «설정 접기» (open), the summary and the big button name the device, a setup row\'s button names the device AND its date', async () => {
    await render();
    const row = q('desktop-computer-row')[0];
    const summary = row.querySelector('summary') as HTMLElement;
    expect(summary.getAttribute('aria-label')).toBe('SYJ-MacBook-Pro의 설정 보기');
    expect(summary.textContent).toContain('설정 보기');
    expect(summary.textContent).toContain('설정 접기'); // (both words are in the DOM; the CSS shows the one that fits the state)
    expect(q('desktop-computer-disconnect-all')[0].getAttribute('aria-label')).toBe('SYJ-MacBook-Pro 연결 모두 끊기');
    expect(q('desktop-computer-disconnect-all')[0].textContent).toBe('이 컴퓨터 모두 끊기');
    expect(q('desktop-device-disconnect')[0].getAttribute('aria-label')).toMatch(/^SYJ-MacBook-Pro의 설정 연결 끊기 · 에이전트1 · \d+월 \d+일$/); // (the first agent's name rides along — story 4734 §A-2b)
    expect(q('desktop-device-disconnect')).toHaveLength(4); // a setup row each (3 + 1)
    // the setups of one computer are told apart by their date, in the agents fold's name as well as the button's
    const folds = [...q('desktop-computer-setups')[0].querySelectorAll('summary')].map((n) => n.getAttribute('aria-label'));
    expect(folds).toHaveLength(3);
    expect(folds.every((f) => /^SYJ-MacBook-Pro의 설정 에이전트 보기 · \d+월 \d+일$/.test(f ?? ''))).toBe(true);
  });

  it('`#device=<setup_id>` opens the computer that holds that setup', async () => {
    window.location.hash = `#device=${sid(2)}`;
    await render();
    await act(async () => { await Promise.resolve(); });
    expect((q('desktop-computer-details')[0] as HTMLDetailsElement).open).toBe(true);
    expect((q('desktop-computer-details')[1] as HTMLDetailsElement).open).toBe(false);
  });

  it('the list is asked at /api/desktop/computers and an unreadable answer hides nothing it should not: a row without its ids is dropped', async () => {
    const res = new Response(JSON.stringify({ computers: [{ device_name: 'no id', setups: [] }, JSON.parse(list(computer(C1, 'ok', [setup(1)]))).computers[0]], truncated: true }), { status: 200 });
    const read = await readComputers(res);
    expect(read?.computers.map((c) => c.device_name)).toEqual(['ok']);
    expect(read?.truncated).toBe(true);
    expect(await readComputers(new Response('{}', { status: 403 }))).toBeNull();
    await render();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/desktop/computers');
  });
});

describe('[4734] «이 컴퓨터 모두 끊기» — asked big, once; all or none', () => {
  it('the confirm names the scope as a number, says «되돌릴 수 없어요» first and bold, says the paired phones lose it, and the button carries the same number; cancel sends nothing', async () => {
    await render();
    await click(q('desktop-computer-disconnect-all')[0]);
    const body = q('desktop-computers-confirm-body')[0];
    const lines = [...body.querySelectorAll('[data-testid="desktop-computers-confirm-line"]')];
    expect(lines[0].textContent).toBe('되돌릴 수 없어요.');
    expect(lines[0].className).toContain('font-semibold');
    expect(lines[1].textContent).toBe('이 컴퓨터에서 연결한 설정 3곳이 모두 끊기고, 에이전트 3개가 멈춰요 — 더는 Sprintable 일감을 받지 않고, 조직의 에이전트 수에서도 빠져요.');
    expect(lines[2].textContent).toBe('이 컴퓨터와 페어링한 폰도 모두 이 컴퓨터를 더는 다룰 수 없어요.');
    expect(document.body.textContent).toContain('SYJ-MacBook-Pro 연결을 모두 끊을까요?');
    const confirm = q('desktop-computers-confirm-all')[0];
    expect(confirm.textContent).toBe('설정 3곳 모두 끊기');
    await click([...document.querySelectorAll('button')].find((b) => b.textContent === '취소')!);
    expect(deletes()).toEqual([]);
    expect(q('desktop-computers-confirm-all')).toHaveLength(0);
  });

  it('confirming sends ONE DELETE for the computer, marks every connected setup disconnected at once and says «{device} 연결을 모두 끊었어요 · 설정 N곳»', async () => {
    await render();
    await click(q('desktop-computer-disconnect-all')[0]);
    await click(q('desktop-computers-confirm-all')[0]);
    await flush();
    expect(deletes()).toEqual([`/api/desktop/computers/${C1}`]);
    expect(q('desktop-devices-done')[0].textContent).toBe('SYJ-MacBook-Pro 연결을 모두 끊었어요 · 설정 3곳');
    const states = q('desktop-computer-state').map((n) => n.textContent);
    expect(states).toEqual(['연결됨', '연결 끊김']); // the other computer stays connected and moves up; this one moved down
    expect(q('desktop-computer-name').map((n) => n.textContent)).toEqual(['사무실 맥', 'SYJ-MacBook-Pro']);
    expect(q('desktop-computer-disconnect-all')).toHaveLength(1); // a disconnected computer has nothing left to disconnect
    expect(q('desktop-device-disconnect')).toHaveLength(1); // …nor do its setup rows
    // the pressed button is gone: focus goes to the NEXT computer's line (Yuna §A-4), not back to the top
    expect(document.activeElement?.tagName).toBe('SUMMARY');
    expect(document.activeElement?.closest('[data-computer-id]')?.getAttribute('data-computer-id')).toBe(C2);
  });

  it('another admin finished first: «이미 끊겨 있었어요» (no count claimed)', async () => {
    await render();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ setups_disconnected: 0, revoked_keys: 0, already_disconnected: true, revoked_at: null, revoked_by_name: null }), { status: 200 }));
    await click(q('desktop-computer-disconnect-all')[0]);
    await click(q('desktop-computers-confirm-all')[0]);
    await flush();
    expect(q('desktop-devices-done')[0].textContent).toBe('SYJ-MacBook-Pro 연결은 이미 끊겨 있었어요');
  });

  it('a refusal (409: the computer changed while it was locked) or a failure keeps the dialog, says «연결을 모두 끊지 못했어요», changes nothing on the list — and a 409 reads the list again', async () => {
    await render();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'computer_changing' } }), { status: 409 }));
    await click(q('desktop-computer-disconnect-all')[0]);
    await click(q('desktop-computers-confirm-all')[0]);
    await flush();
    expect(q('desktop-devices-failed')[0].textContent).toBe('연결을 모두 끊지 못했어요 — 다시 시도해 주세요');
    expect(q('desktop-computers-confirm-all')).toHaveLength(1); // the dialog stays
    expect(q('desktop-computer-state')[0].textContent).toBe('연결됨');
    expect(fetchMock.mock.calls.filter(([url, init]) => url === '/api/desktop/computers' && !(init as RequestInit | undefined)?.method)).toHaveLength(2); // the 409 re-read the list
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await click(q('desktop-computers-confirm-all')[0]);
    await flush();
    expect(q('desktop-devices-failed')[0].textContent).toBe('연결을 모두 끊지 못했어요 — 다시 시도해 주세요');
  });

  it('the answer of a disconnect asked in the previous org (an org switch in between) touches nothing in the new org: its list, its dialog and its line stay', async () => {
    await render();
    let answer!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { answer = r; }));
    await click(q('desktop-computer-disconnect-all')[0]);
    await click(q('desktop-computers-confirm-all')[0]);
    listBody = list(computer('c3333333-3333-4333-8333-333333333333', 'second org mac', [setup(9, { device_name: 'second org mac' })]));
    useDashboardContextMock.mockReturnValue({
      orgId: 'org-2', orgMemberships: [{ orgId: 'org-1', orgName: '뭉클랩', orgSlug: 'moonklabs', role: 'admin' }, { orgId: 'org-2', orgName: '둘째 조직', orgSlug: 'second', role: 'admin' }], projectMemberships: [], userName: '김지우',
    });
    await render();
    expect(q('desktop-computer-name').map((n) => n.textContent)).toEqual(['second org mac']);
    await act(async () => { answer(new Response(all(1, 2, 3), { status: 200 })); });
    await flush();
    expect(q('desktop-computer-name').map((n) => n.textContent)).toEqual(['second org mac']);
    expect(q('desktop-computer-state')[0].textContent).toBe('연결됨'); // not marked disconnected by the other org's answer
    expect(q('desktop-devices-done')[0].textContent).toBe(''); // and no «모두 끊었어요» line from it
  });

  it('while it works both buttons are locked and the action reads «끊는 중…»', async () => {
    await render();
    let answer!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { answer = r; }));
    await click(q('desktop-computer-disconnect-all')[0]);
    await click(q('desktop-computers-confirm-all')[0]);
    const confirm = q('desktop-computers-confirm-all')[0] as HTMLButtonElement;
    const cancel = [...document.querySelectorAll('button')].find((b) => b.textContent === '취소') as HTMLButtonElement;
    expect([confirm.textContent, confirm.disabled, cancel.disabled]).toEqual(['끊는 중…', true, true]);
    await act(async () => { answer(new Response(all(1, 2, 3), { status: 200 })); });
    await flush();
    expect(q('desktop-computers-confirm-all')).toHaveLength(0);
  });

  it('en: the same screen in English (counts as plurals)', async () => {
    await render('en');
    expect(q('desktop-computer-meta')[0].textContent).toMatch(/^3 agents · 3 setups/);
    expect(q('desktop-computer-meta')[1].textContent).toMatch(/^1 agent · 1 setup/); // (plural by count)
    await click(q('desktop-computer-disconnect-all')[0]);
    expect(q('desktop-computers-confirm-line')[0].textContent).toBe("This can't be undone.");
    expect(q('desktop-computers-confirm-all')[0].textContent).toBe('Disconnect all 3 setups');
  });
});

describe('[4734] a setup row\'s own «연결 끊기»', () => {
  it('says «이 설정만 끊어요 — 이 컴퓨터의 다른 설정 {m}곳은 그대로예요.» (bold) when the computer has other connected setups — and not when it is the last', async () => {
    await render();
    await click(q('desktop-device-disconnect')[0]); // a setup of the 3-setup computer
    expect(q('desktop-devices-only-this')[0].textContent).toBe('이 설정만 끊어요 — 이 컴퓨터의 다른 설정 2곳은 그대로예요.');
    expect(q('desktop-devices-confirm-body')[0].textContent).toBe(
      '끊으면 이 기기의 에이전트 1개가 멈춰요 — 더는 Sprintable 일감을 받지 않고, 조직의 에이전트 수에서도 빠져요. 이 설정만 끊어요 — 이 컴퓨터의 다른 설정 2곳은 그대로예요. 에이전트의 기록과 한 일은 조직에 그대로 남아요. 이 기기를 다시 쓰려면 그 기기에서 설정을 새로 해 주세요.',
    );
    await click([...document.querySelectorAll('button')].find((b) => b.textContent === '취소')!);
    await click(q('desktop-device-disconnect')[3]); // the other computer's only setup
    expect(q('desktop-devices-only-this')).toHaveLength(0);
    expect(q('desktop-devices-confirm-body')[0].textContent).toBe(
      '끊으면 이 기기의 에이전트 1개가 멈춰요 — 더는 Sprintable 일감을 받지 않고, 조직의 에이전트 수에서도 빠져요. 에이전트의 기록과 한 일은 조직에 그대로 남아요. 이 기기를 다시 쓰려면 그 기기에서 설정을 새로 해 주세요.',
    );
  });

  it('deletes only that setup: the computer stays connected while another setup is, and the line says so', async () => {
    await render();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ revoked_keys: 1, already_disconnected: false, revoked_at: '2026-09-30T05:00:00Z', revoked_by_name: '김지우' }), { status: 200 }));
    await click(q('desktop-device-disconnect')[0]);
    await click(q('desktop-devices-confirm')[0]);
    await flush();
    expect(deletes()).toEqual([`/api/desktop/setups/${sid(1)}`]);
    expect(q('desktop-devices-done')[0].textContent).toBe('SYJ-MacBook-Pro 연결을 끊었어요');
    expect(q('desktop-computer-state')[0].textContent).toBe('연결됨'); // two of its setups are still connected
    expect(q('desktop-computer-meta')[0].textContent).toMatch(/^에이전트 2개 · 설정 2곳/);
  });
});

describe('[4734] the in-between line (a computer\'s setups hold different numbers of phones)', () => {
  const comp = (counts: number[], states: string[] = []): DesktopComputer => JSON.parse(list(computer(C1, 'x', counts.map((c, i) => setup(i + 1, { paired_phones: c, state: states[i] ?? 'handed_over' }))))).computers[0];
  it('shows «폰 페어링이 설정 N곳 중 K곳에만 돼 있어요» only while they differ, never when equal · none paired · one setup · a count unknown', async () => {
    expect(pairedPhoneGap(comp([2, 0, 2]))).toEqual({ n: 3, k: 2 });
    expect(pairedPhoneGap(comp([1, 1, 1]))).toBeNull();
    expect(pairedPhoneGap(comp([0, 0]))).toBeNull();
    expect(pairedPhoneGap(comp([2]))).toBeNull();
    expect(pairedPhoneGap(comp([2, 0], ['handed_over', 'disconnected']))).toBeNull(); // the disconnected one does not count
    listBody = list(computer(C1, 'SYJ-MacBook-Pro', [setup(1, { paired_phones: 2 }), setup(2, { paired_phones: 0 })]));
    await render();
    expect(q('desktop-computer-pair-gap')[0].textContent).toBe('폰 페어링이 설정 2곳 중 1곳에만 돼 있어요 — 그 컴퓨터의 앱을 최신으로 업데이트하면 모두 맞춰져요.');
  });
});


describe('[4734 · Yuna §A-2b] a setup row names its agents', () => {
  const named = (n: number, names: Array<string | null>, over: Record<string, unknown> = {}) => setup(n, {
    members: names.flatMap((name, i) => [{ kind: 'agent', member_id: `ag-${n}-${i}`, name, role: 'Dev' }, { kind: 'agent', member_id: `ag-${n}-${i}`, name, role: 'Reviewer' }]).concat([{ kind: 'human', member_id: 'person', name: '김지우', role: 'direct' } as never]),
    ...over,
  });
  const openFold = async () => { await render(); await click(q('desktop-computer-row')[0].querySelector('summary')!); };
  const rowMeta = (i: number) => q('desktop-device-meta')[i].textContent;

  it('1 · 2 · 3+ names and the fallback: «A» · «A · B» · «A · B 외 k» · no name → «에이전트 n개» (the same agent holding two stages is one name)', async () => {
    listBody = list(computer(C1, 'SYJ-MacBook-Pro', [
      named(1, ['결제 담당']), named(2, ['결제 담당', '문서 정리']), named(3, ['결제 담당', '문서 정리', '리뷰 도우미', '사무실 점검']), named(5, [null, '  ']),
    ]));
    await openFold();
    expect(rowMeta(0)).toMatch(/^결제 담당 · \d+월 \d+일 연결 · 연결한 사람 김지우$/);
    expect(rowMeta(1)).toMatch(/^결제 담당 · 문서 정리 · \d+월 \d+일 연결/);
    expect(rowMeta(2)).toMatch(/^결제 담당 · 문서 정리 외 2 · \d+월 \d+일 연결/);
    expect(rowMeta(3)).toMatch(/^에이전트 2개 · \d+월 \d+일 연결/); // two agents with no usable name: the count, as before
    expect(q('desktop-computer-meta')[0].textContent).toMatch(/^에이전트 \d+개 · 설정 4곳/); // the computer's line keeps the totals
  });

  it('en: «A · B and 2 more» and the aria label carries the first name', async () => {
    listBody = list(computer(C1, 'Mac', [named(3, ['Pay', 'Docs', 'Review', 'Office'])]));
    await render('en');
    await click(q('desktop-computer-row')[0].querySelector('summary')!);
    expect(rowMeta(0)).toMatch(/^Pay · Docs and 2 more · /);
    expect(q('desktop-device-disconnect')[0].getAttribute('aria-label')).toMatch(/^Disconnect one setup of Mac · Pay · /);
  });

  it('the button\'s aria-label: «{device}의 설정 연결 끊기 · {첫 이름} · {날짜}» (no name → as before)', async () => {
    listBody = list(computer(C1, 'SYJ-MacBook-Pro', [named(1, ['결제 담당', '문서 정리']), named(2, [null])]));
    await openFold();
    const labels = q('desktop-device-disconnect').map((b) => b.getAttribute('aria-label'));
    expect(labels[0]).toMatch(/^SYJ-MacBook-Pro의 설정 연결 끊기 · 결제 담당 · \d+월 \d+일$/);
    expect(labels[1]).toMatch(/^SYJ-MacBook-Pro의 설정 연결 끊기 · \d+월 \d+일$/);
  });

  it('the single-setup confirm gets a muted first line «이 설정의 에이전트: …» — the old sentence stays untouched; no names → no line', async () => {
    listBody = list(computer(C1, 'SYJ-MacBook-Pro', [named(1, ['결제 담당', '문서 정리', '리뷰 도우미']), named(2, [null])]));
    await openFold();
    await click(q('desktop-device-disconnect')[0]);
    expect(q('desktop-devices-confirm-agents')[0].textContent).toBe('이 설정의 에이전트: 결제 담당 · 문서 정리 외 1');
    expect(q('desktop-devices-confirm-body')[0].textContent).toContain('끊으면 이 기기의 에이전트 3개가 멈춰요'); // (the particle sentence is the old one)
    await click([...document.querySelectorAll('button')].find((b) => b.textContent === '취소')!);
    await click(q('desktop-device-disconnect')[1]);
    expect(q('desktop-devices-confirm-agents')).toHaveLength(0);
  });
});

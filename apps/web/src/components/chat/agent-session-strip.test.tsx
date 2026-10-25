// @vitest-environment jsdom
//
// story #4534 (명세 모음 B-3 · «상태 칩 ↔ 서버 세션 상태») — the agent's session in its DM: six states with the desktop bar's
// words and shapes, one line where the phone's buttons would be (working: the phone · off: why · unknown: the lost line ·
// waiting: the inbox link · the rest: none). No button on the web. Reads again on its own `desktop.session_changed`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (p: string) => p }));
// the widened line's time is the viewer's clock: pinned to Seoul so the expected «20:51» holds on any machine (the CI runner is UTC)
vi.mock('@/components/viewer-time-zone', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/components/viewer-time-zone')>()), useViewerTimeZone: () => 'Asia/Seoul' }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: unknown }) => <a href={href} {...rest}>{children as never}</a> }));
let onExtra: ((name: string, data: unknown) => void) | undefined;
vi.mock('@/hooks/use-sse-notifications', () => ({
  useSseNotifications: (o: { onExtraEvent?: typeof onExtra }) => { onExtra = o.onExtraEvent; },
}));
const { AgentSessionStrip, sessionStateLabel } = await import('./agent-session-strip');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const view = (over: Record<string, unknown> = {}) => new Response(JSON.stringify({
  device_name: 'SYJ-MacBook-Pro', state: 'working', remote_control: true, pending_permission_request_id: null, ...over,
}), { status: 200 });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { fetchWithAuth.mockReset(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function render(locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <AgentSessionStrip agentId="a-1" conversationId="c-1" />
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
const chip = () => container.querySelector('[data-testid="agent-session-chip"]')?.textContent;
const line = () => container.querySelector('[data-testid="agent-session-line"]')?.textContent ?? null;

describe('AgentSessionStrip (story #4534)', () => {
  it.each([
    ['starting', '시작됨', null],
    ['working', '작업 중', '페어링된 폰에서 멈추거나 지시할 수 있어요'],
    ['idle', '다음 일 기다림', null],
    ['waiting_permission', '권한 대기', '권한 요청은 결재함에 있어요'],
    ['stopped', '끝', null],
    ['unknown', '상태 모름', '그 컴퓨터와 연결이 끊겨 지금 상태를 몰라요 — 다시 연결되면 여기서 바로 바뀌어요'],
  ])('%s → «%s» and its line, no button', async (state, word, expected) => {
    fetchWithAuth.mockResolvedValueOnce(view({ state }));
    await render();
    expect(fetchWithAuth.mock.calls[0][0]).toBe('/api/agents/a-1/desktop-session');
    expect(chip()).toBe(word);
    expect(line()).toBe(expected);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('remote control off says why — over the permission line too; not on a computer draws nothing', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ remote_control: false }));
    await render();
    expect(line()).toBe('원격 제어가 꺼져 있어 폰에서 멈추거나 지시할 수 없어요 — 조직 소유자가 켤 수 있어요'); // story #4583 (no org read here: no names)
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'waiting_permission', remote_control: false }));
    await render();
    expect(line()).toBe('원격 제어가 꺼져 있어 폰에서 멈추거나 지시할 수 없어요 — 조직 소유자가 켤 수 있어요'); // story #4583 (no org read here: no names)
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    fetchWithAuth.mockResolvedValueOnce(view({ state: null }));
    await render();
    expect(container.innerHTML).toBe('');
  });

  it('reads again on its own agent\'s nudge only, and the computer gone quiet shows «상태 모름»', async () => {
    fetchWithAuth.mockResolvedValueOnce(view());
    await render();
    await act(async () => { onExtra?.('desktop.session_changed', JSON.stringify({ agent_member_id: 'other' })); });
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'unknown' }));
    await act(async () => { onExtra?.('desktop.session_changed', JSON.stringify({ agent_member_id: 'a-1' })); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(chip()).toBe('상태 모름');
  });

  it('marks and tones are the desktop bar\'s: idle a filled muted dot · done a success check · working primary · waiting warning', async () => {
    for (const [state, cls] of [['idle', 'fill-current'], ['stopped', 'text-success'], ['working', 'text-primary'], ['waiting_permission', 'text-warning']]) {
      fetchWithAuth.mockResolvedValueOnce(view({ state }));
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      await render();
      expect(container.querySelector('[data-testid="agent-session-chip"] svg')?.getAttribute('class')).toContain(cls);
    }
  });

  it('reads in English', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'idle' }));
    await render('en');
    expect(chip()).toBe('Waiting for work');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    fetchWithAuth.mockResolvedValueOnce(view());
    await render('en');
    expect(chip()).toBe('Working');
    expect(line()).toBe('You can stop or instruct it from a paired phone');
  });
});

// story #4534 (relay contract v1.12 · Yuna 03:04Z · 03:06Z): the board's own words reach the web — never «다음 일 기다림» for an agent
// asked in its terminal, stopped with an error, or paused at a usage limit; their lines stand whatever remote control says; no button
describe('AgentSessionStrip — the board\'s own words (story #4534 · contract v1.12)', () => {
  const later = new Date(Date.now() + 3 * 3600_000).toISOString();
  const earlier = new Date(Date.now() - 3600_000).toISOString();
  it.each([
    [{ state: 'idle', activity: 'waiting_input' }, '입력 대기', '그 컴퓨터의 터미널에서 답을 기다리고 있어요 — 그 컴퓨터에서 답해 주세요', 'text-foreground'],
    [{ state: 'idle', activity: 'error' }, '오류', '에이전트가 오류로 멈췄어요 — 까닭은 그 컴퓨터의 데스크톱 앱에서 볼 수 있어요', 'text-destructive'],
    [{ state: 'idle', activity: 'waiting_input', limit: { self_resume: 'maybe' } }, '사용 한도', '사용 한도에 걸렸어요 — 그 컴퓨터의 터미널에 고르는 창이 떠 있으면 거기서 골라 주세요. 창이 없으면 한도가 풀릴 때 스스로 이어서 해요', 'text-warning'],
    [{ state: 'idle', activity: 'waiting_input', limit: { self_resume: 'no' } }, '사용 한도', '사용 한도에 걸렸어요 — 스스로 이어 가지 않아요. 한도가 풀린 뒤 그 컴퓨터의 터미널에서 다시 보내 주세요', 'text-warning'],
    [{ state: 'idle', activity: 'waiting_input', limit: { self_resume: 'unknown' } }, '사용 한도', '사용 한도에 걸렸어요 — 그 컴퓨터의 터미널에서 어떻게 이어 갈지 확인해 주세요', 'text-warning'],
    [{ state: 'idle', activity: 'error', limit: {} }, '오류', '사용 한도에 걸려 멈췄어요 — 풀리는 시각은 그 컴퓨터의 터미널에서 볼 수 있어요', 'text-destructive'],
    [{ state: 'idle', activity: 'error', limit: { at: earlier } }, '오류', '한도가 풀렸어요 — 그 컴퓨터에서 다시 시작해 주세요', 'text-destructive'],
    // story #4599 (contract v1.13 · Yuna ①): held by a macOS window — a reader from before sees `working`; this page sees the word; the
    // folder named only when the daemon read it (macOS's own «데스크탑» · «네트워크 볼륨을» without «폴더»)
    [{ state: 'working', activity: 'waiting_system' }, 'macOS 창 대기', 'macOS가 그 컴퓨터 화면에서 폴더를 쓸지 묻고 있어요 — 여기서는 답할 수 없어요. 그 컴퓨터 앞에서 창에 답하거나, 폰에서 [인계 없이 끝내기]를 누르거나, 데스크톱 앱에서 [끝내기]를 눌러 주세요', 'text-warning'],
    [{ state: 'working', activity: 'waiting_system', system: { folder: 'desktop' } }, 'macOS 창 대기', 'macOS가 그 컴퓨터 화면에서 데스크탑 폴더를 쓸지 묻고 있어요 — 여기서는 답할 수 없어요. 그 컴퓨터 앞에서 창에 답하거나, 폰에서 [인계 없이 끝내기]를 누르거나, 데스크톱 앱에서 [끝내기]를 눌러 주세요', 'text-warning'],
    [{ state: 'working', activity: 'waiting_system', system: { folder: 'network_volume' } }, 'macOS 창 대기', 'macOS가 그 컴퓨터 화면에서 네트워크 볼륨을 쓸지 묻고 있어요 — 여기서는 답할 수 없어요. 그 컴퓨터 앞에서 창에 답하거나, 폰에서 [인계 없이 끝내기]를 누르거나, 데스크톱 앱에서 [끝내기]를 눌러 주세요', 'text-warning'],
    [{ state: 'working', activity: 'waiting_system', system: { folder: null } }, 'macOS 창 대기', 'macOS가 그 컴퓨터 화면에서 폴더를 쓸지 묻고 있어요 — 여기서는 답할 수 없어요. 그 컴퓨터 앞에서 창에 답하거나, 폰에서 [인계 없이 끝내기]를 누르거나, 데스크톱 앱에서 [끝내기]를 눌러 주세요', 'text-warning'],
    // story #4560 (Yuna `4560-limit-resume-copy.md` §③ · contract v2.1 §5): the app held off at the limit's end — «사용 한도» · its line ·
    // no button, on whichever limit word it comes
    [{ state: 'idle', activity: 'error', limit: { at: earlier, held: 'screen' } }, '사용 한도', '한도가 풀릴 때가 됐지만 그 컴퓨터의 터미널 화면이 예상과 달라 앱이 손대지 않았어요 — 그 컴퓨터의 터미널에서 확인해 주세요', 'text-warning'],
    [{ state: 'idle', activity: 'paused_limit', limit: { at: earlier, held: 'esc_not_taken' } }, '사용 한도', '한도가 풀릴 때가 됐지만 그 컴퓨터의 터미널 화면이 예상과 달라 앱이 손대지 않았어요 — 그 컴퓨터의 터미널에서 확인해 주세요', 'text-warning'],
    // PO 14:55Z: the daemon's own word while held is waiting_input (no self_resume with it) — the same look and line
    [{ state: 'idle', activity: 'waiting_input', limit: { at: earlier, held: 'screen' } }, '사용 한도', '한도가 풀릴 때가 됐지만 그 컴퓨터의 터미널 화면이 예상과 달라 앱이 손대지 않았어요 — 그 컴퓨터의 터미널에서 확인해 주세요', 'text-warning'],
    [{ state: 'idle', activity: 'waiting_input', limit: { self_resume: 'maybe', held: 'screen' } }, '사용 한도', '한도가 풀릴 때가 됐지만 그 컴퓨터의 터미널 화면이 예상과 달라 앱이 손대지 않았어요 — 그 컴퓨터의 터미널에서 확인해 주세요', 'text-warning'],
    // story #4685 (Yuna `limit-notice-1014.md` §③ · PO 10-14 00:39Z): a limit the APP looks at again (`looks`, only a daemon that does says it)
    // is «한도로 쉬는 중» — the quiet dot, one new line for any self_resume; a held one keeps «사용 한도» whatever `looks` says
    [{ state: 'idle', activity: 'waiting_input', limit: { self_resume: 'maybe', looks: true } }, '한도로 쉬는 중', '사용 한도에 걸려 멈췄어요 — 풀리는 시각은 아직 몰라요. 앱이 틈틈이 다시 해 보고, 풀리면 이어서 일해요', 'text-muted-foreground'],
    [{ state: 'idle', activity: 'waiting_input', limit: { self_resume: 'no', looks: true } }, '한도로 쉬는 중', '사용 한도에 걸려 멈췄어요 — 풀리는 시각은 아직 몰라요. 앱이 틈틈이 다시 해 보고, 풀리면 이어서 일해요', 'text-muted-foreground'],
    [{ state: 'idle', activity: 'waiting_input', limit: { self_resume: 'unknown', looks: true } }, '한도로 쉬는 중', '사용 한도에 걸려 멈췄어요 — 풀리는 시각은 아직 몰라요. 앱이 틈틈이 다시 해 보고, 풀리면 이어서 일해요', 'text-muted-foreground'],
    [{ state: 'idle', activity: 'waiting_input', limit: { self_resume: 'maybe', held: 'screen', looks: true } }, '사용 한도', '한도가 풀릴 때가 됐지만 그 컴퓨터의 터미널 화면이 예상과 달라 앱이 손대지 않았어요 — 그 컴퓨터의 터미널에서 확인해 주세요', 'text-warning'],
  ])('%j → «%s» and its line', async (over, word, expected, tone) => {
    fetchWithAuth.mockResolvedValueOnce(view({ ...over, remote_control: false }));
    await render();
    expect(chip()).toBe(word);
    expect(line()).toBe(expected);
    expect(container.querySelector('[data-testid="agent-session-chip"] svg')?.getAttribute('class')).toContain(tone);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
  it('story #4685: `looks` in English — «Paused at usage limit» and the new line; without `looks` (a daemon from before) the old word and line stay', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'idle', activity: 'waiting_input', limit: { self_resume: 'unknown', looks: true }, remote_control: false }));
    await render('en');
    expect(chip()).toBe('Paused at usage limit');
    expect(line()).toBe('Hit the usage limit and stopped — the reset time isn\'t known yet. The app checks again from time to time and carries on once it resets');
    expect(container.querySelector('[data-testid="agent-session-chip"] svg')?.getAttribute('class')).toContain('fill-current');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'idle', activity: 'waiting_input', limit: { self_resume: 'unknown' }, remote_control: false }));
    await render('en');
    expect(chip()).toBe('Usage limit'); // fail-closed: no promise that the app checks again
    expect(line()).toBe('Hit its usage limit — check in that computer\'s terminal how it can go on');
  });
  it('paused at a usage limit: a quiet dot and when it continues (this page\'s clock) · again · a limit still ahead on an error', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'idle', activity: 'paused_limit', limit: { at: later, again: false } }));
    await render();
    expect(chip()).toBe('한도로 쉬는 중');
    expect(line()).toMatch(/^사용 한도에 걸려 멈췄어요 — .+에 이어서 해요$/);
    expect(container.querySelector('[data-testid="agent-session-chip"] svg')?.getAttribute('class')).toContain('fill-current');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'idle', activity: 'paused_limit', limit: { at: later, again: true } }));
    await render('en');
    expect(chip()).toBe('Paused at usage limit');
    expect(line()).toMatch(/^Still at the limit — continues again .+$/);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'idle', activity: 'error', limit: { at: later } }));
    await render();
    expect(line()).toMatch(/^사용 한도에 걸려 멈췄어요 — .+에 풀려요$/);
  });
});

// story 4675 + #4685 (PO 10-14 01:03Z): the strip and the workforce detail's «지금 도는 컴퓨터» line choose the word through ONE function —
// a limit the app looks at again (`looks`) is «한도로 쉬는 중»; held, or no `looks` (a daemon from before), keeps «사용 한도»
describe('sessionStateLabel — the one place the word is chosen', () => {
  const key = (k: string) => k; // the word's key is what is compared
  it('looks → paused_limit\'s word on any self_resume row, on the shown state or the server\'s activity alike', () => {
    for (const self_resume of ['maybe', 'no', 'unknown'] as const) {
      expect(sessionStateLabel({ state: 'waiting_input', limit: { self_resume, looks: true } }, key)).toBe('state.paused_limit');
      expect(sessionStateLabel({ state: 'idle', activity: 'waiting_input', limit: { self_resume, looks: true } }, key)).toBe('state.paused_limit');
    }
  });
  it('held (whatever `looks` says) and no `looks` keep «사용 한도» · other words are untouched', () => {
    expect(sessionStateLabel({ state: 'waiting_input', limit: { self_resume: 'maybe', held: 'screen', looks: true } }, key)).toBe('state.usage_limit');
    expect(sessionStateLabel({ state: 'waiting_input', limit: { self_resume: 'unknown' } }, key)).toBe('state.usage_limit');
    expect(sessionStateLabel({ state: 'waiting_input', limit: null }, key)).toBe('state.waiting_input');
    expect(sessionStateLabel({ state: 'paused_limit', limit: { at: '2026-10-05T05:00:00Z' } }, key)).toBe('state.paused_limit');
    expect(sessionStateLabel({ state: 'error', limit: { looks: true } }, key)).toBe('state.error'); // `looks` rides on the self_resume row only
    expect(sessionStateLabel({ state: 'working' }, key)).toBe('state.working');
  });
});

// story #4534 (Kadir 4960 · PO 05:36Z): a word this page does not know never breaks it — a server newer than this bundle
describe('AgentSessionStrip — a word it does not know', () => {
  it('an unknown activity falls back to the five-word state · an unknown state to «상태 모름» — no crash', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'idle', activity: 'dreaming' }));
    await render();
    expect(chip()).toBe('다음 일 기다림');
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'sleeping', activity: 'dreaming' }));
    await render();
    expect(chip()).toBe('상태 모름');
    // Yuna 05:41Z: the page does not know the word — never the «computer lost» line
    expect(line()).toBe('이 페이지가 아직 모르는 상태예요 — 새로 고치면 보일 수 있어요');
    expect(line()).not.toContain('연결이 끊겨');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
  it('a server from before (state only, no activity) reads as it did', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'working' }));
    await render();
    expect(chip()).toBe('작업 중');
  });
});

// story #4641 (Yuna's copy): the widened line — under the session, plain, the mode it became; a mode with no name yet shows nothing
describe('AgentSessionStrip — a permission widened at the terminal (story #4641)', () => {
  beforeEach(() => { onExtra = undefined; });

  it('shows the mode it became, with the time of day (24h) — in Korean', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'working', permission_widened_at: '2026-10-08T11:51:00Z', permission_widened_from: 'default', permission_widened_to: 'auto' }));
    await render();
    const w = container.querySelector('[data-testid="agent-session-widened"]');
    expect(w?.textContent).toBe('터미널에서 권한을 넓힘 · 20:51 · 자동 모드');
    expect(w?.className).toContain('text-muted-foreground');
    expect(w?.className).not.toMatch(/text-(warning|destructive)/);
  });

  it('reads in English with the English mode name', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'working', permission_widened_at: '2026-10-08T11:51:00Z', permission_widened_from: 'plan', permission_widened_to: 'acceptEdits' }));
    await render('en');
    expect(container.querySelector('[data-testid="agent-session-widened"]')?.textContent).toBe('Permissions widened in the terminal · 20:51 · Accept-edits mode');
  });

  it('shows nothing without a widening, or for a mode with no name yet (bypassPermissions)', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'working' }));
    await render();
    expect(container.querySelector('[data-testid="agent-session-widened"]')).toBeNull();
  });

  it('dontAsk draws its line in Korean with its own name', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'working', permission_widened_at: '2026-10-08T11:51:00Z', permission_widened_from: 'default', permission_widened_to: 'dontAsk' }));
    await render();
    expect(container.querySelector('[data-testid="agent-session-widened"]')?.textContent).toBe('터미널에서 권한을 넓힘 · 20:51 · 묻지 않는 모드');
  });

  it('the two modes Yuna named (dontAsk, bypassPermissions) draw their line; the widest says so in its name', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'working', permission_widened_at: '2026-10-08T11:51:00Z', permission_widened_from: 'auto', permission_widened_to: 'bypassPermissions' }));
    await render('en');
    expect(container.querySelector('[data-testid="agent-session-widened"]')?.textContent).toBe('Permissions widened in the terminal · 20:51 · Bypass-permissions mode (widest)');
  });

  it('a mode outside the list (a newer server ahead of this web) draws no line — never the widest one', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'working', permission_widened_at: '2026-10-08T11:51:00Z', permission_widened_from: 'auto', permission_widened_to: 'someNewMode' }));
    await render('en');
    expect(container.querySelector('[data-testid="agent-session-widened"]')).toBeNull();
  });
  it('a broken `at` skips the line and the rest of the strip still draws (no RangeError takes the strip down)', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'working', permission_widened_at: 'not-a-date', permission_widened_from: 'plan', permission_widened_to: 'auto' }));
    await render('en');
    expect(container.querySelector('[data-testid="agent-session-widened"]')).toBeNull();
    expect(chip()).toBe('Working');
  });
});

// story 4686 (AC2 · Yuna run-info-1014 (2)): one muted line UNDER the status — what the session really runs on; nothing when the server tells none
describe('AgentSessionStrip — what it runs on (story 4686)', () => {
  const runLine = () => container.querySelector('[data-testid="agent-session-run"]');
  const RUN = { model: 'claude-fable-5-1', model_set: false, effort: 'high', account: 'moonklabs (Max)' };

  it('says the model (+ «· 런타임 기본값» when nobody chose it) · thinking depth · account, under the status line, whole in its title', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'working', run: RUN }));
    await render();
    expect(runLine()?.textContent).toBe('claude-fable-5-1 · 런타임 기본값 · 생각 깊이 높게 · moonklabs (Max)');
    expect(runLine()?.getAttribute('title')).toBe('claude-fable-5-1 · 런타임 기본값 · 생각 깊이 높게 · moonklabs (Max)');
    // under the status: the status line comes first in the document
    const status = container.querySelector('[data-testid="agent-session-line"]')!;
    expect(status.compareDocumentPosition(runLine()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('English words; a named model carries no suffix; no account → no tail', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'idle', run: { model: 'gpt-5-codex', model_set: true, effort: 'medium' } }));
    await render('en');
    expect(runLine()?.textContent).toBe('gpt-5-codex · Thinking depth Medium');
  });

  it('a thinking depth this page does not know is left out of the line — never shown as «기본값»', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'working', run: { model: 'claude-fable-5-1', model_set: true, effort: 'turbo', account: 'moonklabs (Max)' } }));
    await render();
    expect(runLine()?.textContent).toBe('claude-fable-5-1 · moonklabs (Max)');
  });

  it('no `run` from the server (an older one, a silent computer, a stopped session) → no line at all', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'working' }));
    await render();
    expect(runLine()).toBeNull();
  });
});

// story 4684 (Yuna ux1-copy §L ② ③): one line under the status when THIS computer receives no new work for the agent — ② another place is
// receiving (muted fact line) · ③ another place took the agent over (warning tone). No button: taking it back is the app's [여기서 받기]
describe('AgentSessionStrip — why this computer receives no new work (story 4684)', () => {
  const inboxLine = () => container.querySelector('[data-testid="agent-session-inbox"]');
  const takeBackButtons = () => Array.from(container.querySelectorAll('button')).filter((b) => /여기서 받기|Receive here/.test(b.textContent ?? ''));

  it('② another place is receiving: the muted fact line with the computer\'s name — under the status line, no button', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'working', inbox: { stream: 'stopped_other_receiver' } }));  // working has a status line to sit under
    await render();
    expect(inboxLine()?.textContent).toBe('다른 곳에서 이 에이전트의 일을 받고 있어 SYJ-MacBook-Pro에서는 새 일을 받지 않아요');
    expect(inboxLine()?.getAttribute('data-stop')).toBe('other_receiver');
    expect(inboxLine()?.className).toContain('text-muted-foreground');
    expect(inboxLine()?.className).not.toContain('text-warning');
    const status = container.querySelector('[data-testid="agent-session-line"]');
    expect(status).not.toBeNull();  // the status line is there, and the inbox line comes after it
    expect(status!.compareDocumentPosition(inboxLine()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(takeBackButtons()).toHaveLength(0);
  });

  it('a very long computer name without spaces cannot push the line past the phone\'s width (Yuna PASS note: break-keep + overflow-wrap:anywhere), both tones', async () => {
    for (const stream of ['stopped_other_receiver', 'stopped_taken_over']) {
      fetchWithAuth.mockResolvedValueOnce(view({ state: 'idle', device_name: 'SYJ-MacBook-Pro-'.repeat(8) + 'x', inbox: { stream } }));
      await render();
      expect(inboxLine()?.className).toContain('[overflow-wrap:anywhere]');
      expect(inboxLine()?.className).toContain('break-keep');
      await act(async () => { root.unmount(); });
      root = createRoot(container);
    }
  });

  it('②′ no computer name → «this session» wording', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'idle', device_name: null, inbox: { stream: 'stopped_other_receiver' } }));
    await render();
    expect(inboxLine()?.textContent).toBe('다른 곳에서 이 에이전트의 일을 받고 있어 이 세션에는 새 일이 오지 않아요');
  });

  it('③ taken over: the warning tone, names the computer twice and where to press — still no button here', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'idle', inbox: { stream: 'stopped_taken_over' } }));
    await render();
    expect(inboxLine()?.textContent).toBe('다른 곳에서 이 에이전트의 일을 넘겨받아 SYJ-MacBook-Pro에서는 새 일을 받지 않아요 — 되돌리려면 SYJ-MacBook-Pro의 앱에서 [여기서 받기]를 눌러 주세요');
    expect(inboxLine()?.getAttribute('data-stop')).toBe('taken_over');
    expect(inboxLine()?.className).toContain('text-warning');
    expect(takeBackButtons()).toHaveLength(0);
  });

  it('③′ no computer name → the session\'s own computer wording', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'idle', device_name: '   ', inbox: { stream: 'stopped_taken_over' } }));
    await render();
    expect(inboxLine()?.textContent).toBe('다른 곳에서 이 에이전트의 일을 넘겨받아 이 세션에는 새 일이 오지 않아요 — 되돌리려면 이 세션이 도는 컴퓨터의 앱에서 [여기서 받기]를 눌러 주세요');
  });

  it('English words for both', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'idle', inbox: { stream: 'stopped_other_receiver' } }));
    await render('en');
    expect(inboxLine()?.textContent).toBe("Another place is receiving this agent's work, so new work doesn't come to SYJ-MacBook-Pro");
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'idle', inbox: { stream: 'stopped_taken_over' } }));
    await render('en');
    expect(inboxLine()?.textContent).toBe("Another place took over this agent's work, so new work no longer comes to SYJ-MacBook-Pro — to take it back, press [Receive here] in the app on SYJ-MacBook-Pro");
  });

  it.each(['stopped_auth', 'stopped_inbox_full', 'stopped_something_new', 'open', null, undefined])('a stop with no strip words yet / an unknown one (%s) → no line at all', async (stream) => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'idle', inbox: { stream } }));
    await render();
    expect(inboxLine()).toBeNull();
  });

  it('no `inbox` from the server (an older one, a silent computer) → no line', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'idle' }));
    await render();
    expect(inboxLine()).toBeNull();
  });

  it.each(['stopped', 'unknown'])('a session that is not live (%s) shows none even if a stop arrives with it', async (state) => {
    fetchWithAuth.mockResolvedValueOnce(view({ state, inbox: { stream: 'stopped_taken_over' } }));
    await render();
    expect(inboxLine()).toBeNull();
  });
});

// story 4684 (Kadir 5084): the DM moves from agent A to agent B — B's strip must never show A's lines (its stop, its run, its computer)
describe('AgentSessionStrip — another agent\'s view is never shown (story 4684 · Kadir)', () => {
  const inboxLine = () => container.querySelector('[data-testid="agent-session-inbox"]');
  const renderFor = async (agentId: string) => {
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <AgentSessionStrip agentId={agentId} conversationId="c-1" />
        </NextIntlClientProvider>,
      );
    });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
  };
  const failed = () => new Response('{}', { status: 500 });

  it('A shows its stop line; the DM moves to B and B\'s first read fails → nothing of A is left on B\'s screen', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'working', device_name: 'A-맥', inbox: { stream: 'stopped_taken_over' }, run: { model: 'claude-fable-5-1', model_set: true } }));
    await renderFor('a-1');
    expect(inboxLine()?.textContent).toContain('A-맥');
    expect(container.querySelector('[data-testid="agent-session-chip"]')).not.toBeNull();
    fetchWithAuth.mockResolvedValue(failed());
    await renderFor('a-2');
    expect(inboxLine()).toBeNull();
    expect(container.querySelector('[data-testid="agent-session-chip"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-session-run"]')).toBeNull();
    expect(container.textContent).not.toContain('A-맥');
  });

  it('while B\'s first read is still pending, A\'s lines are already gone (nothing of A is shown in the meantime)', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'working', device_name: 'A-맥', inbox: { stream: 'stopped_taken_over' } }));
    await renderFor('a-1');
    expect(inboxLine()?.textContent).toContain('A-맥');
    fetchWithAuth.mockReturnValue(new Promise(() => undefined)); // B's read never comes back during this test
    await renderFor('a-2');
    expect(inboxLine()).toBeNull();
    expect(container.querySelector('[data-testid="agent-session-chip"]')).toBeNull();
    expect(container.textContent).not.toContain('A-맥');
  });

  it('B\'s own successful read replaces it; and a failed read for the SAME agent still keeps what it showed (a blip does not blank the strip)', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'working', device_name: 'A-맥', inbox: { stream: 'stopped_other_receiver' } }));
    await renderFor('a-1');
    expect(inboxLine()?.textContent).toContain('A-맥');
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'idle', device_name: 'B-맥' }));
    await renderFor('a-2');
    expect(inboxLine()).toBeNull();
    expect(container.textContent).toContain('B-맥');
    // the same agent re-reads (the REREAD timer or a nudge) and the read fails: its last view stays
    fetchWithAuth.mockResolvedValue(failed());
    await act(async () => { onExtra?.('desktop.session_changed', JSON.stringify({ agent_member_id: 'a-2' })); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('B-맥');
  });
});

// story #4763 (AC4): a session that has not begun to run says what it waits on — the question at its computer — not «시작됨» for minutes
describe('AgentSessionStrip — the first-screen question (story #4763 AC4 · AC12)', () => {
  it.each(['trust', 'mcp', 'mcp_many', 'update'] as const)('starting + the %s question → «Mac에서 답을 기다려요» (en too) — not «시작됨»', async (ask) => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'starting', first_screen: { ask } }));
    await render();
    expect(chip()).toBe(koMessages.chats.agentSession.state.waiting_first_screen);
    expect(chip()).toBe('Mac에서 답을 기다려요');
    root.unmount(); root = createRoot(container);
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'starting', first_screen: { ask } }));
    await render('en');
    expect(chip()).toBe(enMessages.chats.agentSession.state.waiting_first_screen);
  });

  it('the CLI stands on the question after an instruction went in (the session reads «working»/«idle») → the same line, not «작업 중»', async () => {
    for (const state of ['working', 'idle'] as const) {
      fetchWithAuth.mockResolvedValueOnce(view({ state, first_screen: { ask: 'mcp' } }));
      root.unmount(); root = createRoot(container);
      await render();
      expect(chip(), state).toBe('Mac에서 답을 기다려요');
    }
  });

  it('starting with no question (or an older server that sends none) keeps «시작됨»; the question is gone → «작업 중» (the report without it clears it)', async () => {
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'starting' }));
    await render();
    expect(chip()).toBe('시작됨');
    root.unmount(); root = createRoot(container);
    fetchWithAuth.mockResolvedValueOnce(view({ state: 'working', first_screen: null }));
    await render();
    expect(chip()).toBe('작업 중');
  });

  it('a stopped or lost session keeps its own word: a stale question never covers «끝» / «상태 모름» (and a permission wait keeps «권한 대기»)', async () => {
    for (const [state, word] of [['stopped', '끝'], ['unknown', '상태 모름'], ['waiting_permission', '권한 대기']] as const) {
      fetchWithAuth.mockResolvedValueOnce(view({ state, first_screen: { ask: 'trust' } }));
      root.unmount(); root = createRoot(container);
      await render();
      expect(chip(), state).toBe(word);
    }
  });

  it('sessionStateLabel is the one place that chooses it (the workforce line shares it)', () => {
    const t = (k: string) => k;
    expect(sessionStateLabel({ state: 'starting', first_screen: { ask: 'trust' } }, t)).toBe('state.waiting_first_screen');
    expect(sessionStateLabel({ state: 'starting', first_screen: { ask: 'mcp_many' } }, t)).toBe('state.waiting_first_screen');
    expect(sessionStateLabel({ state: 'starting' }, t)).toBe('state.starting');
    expect(sessionStateLabel({ state: 'starting', first_screen: null }, t)).toBe('state.starting');
  });
});

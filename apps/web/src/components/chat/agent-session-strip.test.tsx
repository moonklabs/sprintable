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
const { AgentSessionStrip } = await import('./agent-session-strip');

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
    [{ state: 'working', activity: 'waiting_system' }, 'macOS 창 대기', 'macOS가 그 컴퓨터 화면에서 폴더를 쓸지 묻고 있어요 — 여기서는 답할 수 없어요. 그 컴퓨터 앞에서 창에 답하거나, 폰에서 [세션 끝내기]를 누르거나, 데스크톱 앱에서 [끝내기]를 눌러 주세요', 'text-warning'],
    [{ state: 'working', activity: 'waiting_system', system: { folder: 'desktop' } }, 'macOS 창 대기', 'macOS가 그 컴퓨터 화면에서 데스크탑 폴더를 쓸지 묻고 있어요 — 여기서는 답할 수 없어요. 그 컴퓨터 앞에서 창에 답하거나, 폰에서 [세션 끝내기]를 누르거나, 데스크톱 앱에서 [끝내기]를 눌러 주세요', 'text-warning'],
    [{ state: 'working', activity: 'waiting_system', system: { folder: 'network_volume' } }, 'macOS 창 대기', 'macOS가 그 컴퓨터 화면에서 네트워크 볼륨을 쓸지 묻고 있어요 — 여기서는 답할 수 없어요. 그 컴퓨터 앞에서 창에 답하거나, 폰에서 [세션 끝내기]를 누르거나, 데스크톱 앱에서 [끝내기]를 눌러 주세요', 'text-warning'],
    [{ state: 'working', activity: 'waiting_system', system: { folder: null } }, 'macOS 창 대기', 'macOS가 그 컴퓨터 화면에서 폴더를 쓸지 묻고 있어요 — 여기서는 답할 수 없어요. 그 컴퓨터 앞에서 창에 답하거나, 폰에서 [세션 끝내기]를 누르거나, 데스크톱 앱에서 [끝내기]를 눌러 주세요', 'text-warning'],
    // story #4560 (Yuna `4560-limit-resume-copy.md` §③ · contract v2.1 §5): the app held off at the limit's end — «사용 한도» · its line ·
    // no button, on whichever limit word it comes
    [{ state: 'idle', activity: 'error', limit: { at: earlier, held: 'screen' } }, '사용 한도', '한도가 풀릴 때가 됐지만 그 컴퓨터의 터미널 화면이 예상과 달라 앱이 손대지 않았어요 — 그 컴퓨터의 터미널에서 확인해 주세요', 'text-warning'],
    [{ state: 'idle', activity: 'paused_limit', limit: { at: earlier, held: 'esc_not_taken' } }, '사용 한도', '한도가 풀릴 때가 됐지만 그 컴퓨터의 터미널 화면이 예상과 달라 앱이 손대지 않았어요 — 그 컴퓨터의 터미널에서 확인해 주세요', 'text-warning'],
    // PO 14:55Z: the daemon's own word while held is waiting_input (no self_resume with it) — the same look and line
    [{ state: 'idle', activity: 'waiting_input', limit: { at: earlier, held: 'screen' } }, '사용 한도', '한도가 풀릴 때가 됐지만 그 컴퓨터의 터미널 화면이 예상과 달라 앱이 손대지 않았어요 — 그 컴퓨터의 터미널에서 확인해 주세요', 'text-warning'],
    [{ state: 'idle', activity: 'waiting_input', limit: { self_resume: 'maybe', held: 'screen' } }, '사용 한도', '한도가 풀릴 때가 됐지만 그 컴퓨터의 터미널 화면이 예상과 달라 앱이 손대지 않았어요 — 그 컴퓨터의 터미널에서 확인해 주세요', 'text-warning'],
  ])('%j → «%s» and its line', async (over, word, expected, tone) => {
    fetchWithAuth.mockResolvedValueOnce(view({ ...over, remote_control: false }));
    await render();
    expect(chip()).toBe(word);
    expect(line()).toBe(expected);
    expect(container.querySelector('[data-testid="agent-session-chip"] svg')?.getAttribute('class')).toContain(tone);
    expect(container.querySelectorAll('button')).toHaveLength(0);
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

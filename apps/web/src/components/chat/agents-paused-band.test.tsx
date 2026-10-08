// @vitest-environment jsdom
//
// story #4631 C · D (Yuna «4631» `4631-breaker-band-copy.md`) — the «agent messages paused» band: what · since · how it is released
// (manual / auto with the server's minutes) · [멈춤 풀기] for an owner/admin only, an in-line confirmation ([취소] first) with a
// required one-line reason (≤ 200), and the result line in the band's place.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const fetchWithAuth = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('@/components/viewer-time-zone', () => ({ useViewerTimeZone: () => 'Asia/Seoul' }));
const { AgentsPausedBand } = await import('./agents-paused-band');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const opened = new Date(Date.now() - 12 * 60_000).toISOString();
const manual = (canRelease: boolean) => ({ opened_at: opened, release_mode: 'manual', can_release: canRelease, auto_release_after_minutes: null });
const auto = (canRelease: boolean, n = 10) => ({ opened_at: opened, release_mode: 'auto', can_release: canRelease, auto_release_after_minutes: n });

let container: HTMLDivElement;
let root: Root;
let onResumed: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  fetchWithAuth.mockReset();
  onResumed = vi.fn<() => void>();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

async function render(state: unknown, locale: 'ko' | 'en' = 'ko') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <AgentsPausedBand conversationId="c-1" state={state as never} onResumed={onResumed} />
      </NextIntlClientProvider>,
    );
  });
}
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const button = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const type = async (value: string) => {
  const input = container.querySelector('input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
async function confirmWith(reason: string, answer: Response) {
  await act(async () => { button('멈춤 풀기')!.click(); });
  await type(reason);
  fetchWithAuth.mockResolvedValueOnce(answer);
  const go = Array.from(container.querySelectorAll('[role="group"] button')).find((b) => b.textContent === '멈춤 풀기') as HTMLButtonElement;
  await act(async () => { go.click(); });
  await flush();
}

describe('AgentsPausedBand (story #4631)', () => {
  it('nothing while no block is open', async () => {
    await render(null);
    expect(container.textContent).toBe('');
  });

  it('owner/admin · manual: what · since · «until an admin resumes» · [멈춤 풀기] · the warning tint (no muted text on it)', async () => {
    await render(manual(true));
    expect(q('agents-paused-band')!.textContent).toContain('이 대화의 에이전트 메시지를 멈췄어요');
    expect(q('agents-paused-band')!.textContent).toContain('에이전트끼리 짧은 사이에 메시지를 너무 많이 주고받았어요. 사람이 보내는 메시지는 그대로 가요.');
    expect(q('agents-paused-release')!.textContent).toBe('관리자가 풀 때까지 멈춰 있어요.');
    expect(q('agents-paused-since')!.textContent).toMatch(/부터$/);
    expect(q('agents-paused-since')!.getAttribute('title')).toBeTruthy(); // the absolute time
    expect(q('agents-paused-band')!.className).toContain('bg-warning-tint');
    expect(q('agents-paused-since')!.className).toContain('text-foreground');
    expect(q('agents-paused-band')!.querySelector('.text-muted-foreground')).toBeNull();
    expect(button('멈춤 풀기')).toBeTruthy();
  });

  it('a plain member · manual: «ask an organization admin», no button, neutral', async () => {
    await render(manual(false));
    expect(q('agents-paused-release')!.textContent).toBe('관리자가 풀 때까지 멈춰 있어요 — 조직 관리자에게 풀어 달라고 해 주세요.');
    expect(button('멈춤 풀기')).toBeUndefined();
    expect(q('agents-paused-band')!.className).toContain('bg-muted');
    expect(q('agents-paused-band')!.className).not.toContain('bg-warning-tint');
  });

  it('auto: the server\'s minutes · neutral · an owner still has [멈춤 풀기]', async () => {
    await render(auto(true, 7));
    expect(q('agents-paused-release')!.textContent).toBe('대화가 7분쯤 조용하면 에이전트가 다시 보낼 수 있어요.');
    expect(q('agents-paused-band')!.className).toContain('bg-muted');
    expect(button('멈춤 풀기')).toBeTruthy();
  });

  it('[멈춤 풀기] confirms in line with [취소] focused · the reason is required (visible line) and at most 200 · [취소] returns to the button', async () => {
    await render(manual(true));
    await act(async () => { button('멈춤 풀기')!.click(); });
    expect(q('agents-paused-band')!.textContent).toContain('에이전트 메시지 멈춤을 풀까요? 풀면 에이전트가 이 대화에 다시 보낼 수 있어요. 같은 일이 또 일어나면 다시 멈춰요.');
    expect(document.activeElement?.textContent).toBe('취소');
    const go = () => Array.from(container.querySelectorAll('[role="group"] button')).find((b) => b.textContent === '멈춤 풀기') as HTMLButtonElement;
    expect(go().disabled).toBe(true);
    expect(container.textContent).toContain('까닭을 한 줄 적어 주세요');
    await type('   ');
    expect(go().disabled).toBe(true);
    await type('x'.repeat(201));
    expect(go().disabled).toBe(true);
    expect(container.textContent).toContain('200자까지 적을 수 있어요');
    await type('원인을 고쳤어요');
    expect(go().disabled).toBe(false);
    await act(async () => { button('취소')!.click(); });
    expect(document.activeElement?.textContent).toBe('멈춤 풀기');
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('resumed: one POST with the reason · the band goes, the result line takes its place (focused) · the page reads again', async () => {
    await render(manual(true));
    await confirmWith('  원인을 고쳤어요  ', json({ conversation_id: 'c-1', released: true }));
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    const [url, init] = fetchWithAuth.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/conversations/c-1/circuit-breaker/release');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ reason: '원인을 고쳤어요' });
    expect(q('agents-paused-band')).toBeNull();
    expect(q('agents-paused-result')!.textContent).toBe('멈춤을 풀었어요 — 에이전트가 다시 보낼 수 있어요');
    expect(document.activeElement).toBe(q('agents-paused-result'));
    expect(onResumed).toHaveBeenCalledTimes(1);
    await render(null); // the page read it again: no block — the result line stays in its place
    expect(q('agents-paused-result')!.textContent).toBe('멈춤을 풀었어요 — 에이전트가 다시 보낼 수 있어요');
  });

  it('already resumed (released:false): says so, the band goes', async () => {
    await render(manual(true));
    await confirmWith('확인', json({ conversation_id: 'c-1', released: false }));
    expect(q('agents-paused-result')!.textContent).toBe('이미 풀려 있었어요');
    expect(q('agents-paused-band')).toBeNull();
  });

  it('403 · another failure: the band and the confirmation stay (the reason kept) with the line under them', async () => {
    await render(manual(true));
    await confirmWith('확인', json({ detail: 'x' }, 403));
    expect(q('agents-paused-result')!.textContent).toBe('관리자만 풀 수 있어요');
    expect(q('agents-paused-band')).toBeTruthy();
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('확인');
    expect(onResumed).not.toHaveBeenCalled();
    fetchWithAuth.mockResolvedValueOnce(json({}, 500));
    const go = Array.from(container.querySelectorAll('[role="group"] button')).find((b) => b.textContent === '멈춤 풀기') as HTMLButtonElement;
    await act(async () => { go.click(); });
    await flush();
    expect(q('agents-paused-result')!.textContent).toBe('풀지 못했어요 — 다시 시도해 주세요');
  });

  it('reads in English', async () => {
    await render(auto(false, 10), 'en');
    expect(q('agents-paused-band')!.textContent).toContain('Agent messages in this conversation are paused');
    expect(q('agents-paused-release')!.textContent).toBe('Once the conversation has been quiet for about 10 minutes, agents can send again.');
    expect(q('agents-paused-since')!.textContent).toMatch(/^since /);
  });
});

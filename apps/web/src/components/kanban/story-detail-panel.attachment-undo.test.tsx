// @vitest-environment jsdom
//
// [SID:4345 · PO 09:59~10:03Z · 유나 규격] 터치에서 늘 보이게 된 첨부 삭제 ✕가 첨부(열기 대상) 위에 있어 오탭 한 번이면 확인 · 되돌리기 없이
// 지워지던 길을 닫는다. 누르면 목록에서만 숨기고 «되돌리기» 토스트 — 서버 삭제(PATCH)는 **토스트가 닫힐 때** 한 번(그때의 최신 목록에서 그 url만 뺌).
// 되돌리기 = 아직 안 보냈으면 요청 취소 · 이미 보냈으면(떠남 · 탭 숨김 flush) 지금 목록에 그 한 항목만 되넣기. 떠날 때(언마운트 · pagehide ·
// visibilitychange hidden) 대기 중인 삭제는 keepalive로 즉시 한 번.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { StoryDetailPanel } from './story-detail-panel';
import type { KanbanStory } from './types';
import koMessages from '../../../messages/ko.json';
import { ToastProvider, ToastContainer, useToast } from '@/components/ui/toast';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ currentMemberType: 'human' }) }));
vi.mock('@/hooks/use-sse-notifications', () => ({ useSseNotifications: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Att = { url: string; name: string; content_type: string; size?: number };
const A1: Att = { url: 'gs://b/a1.pdf', name: 'report.pdf', content_type: 'application/pdf' };
const A2: Att = { url: 'gs://b/a2.pdf', name: 'plan.pdf', content_type: 'application/pdf' };
const A3: Att = { url: 'gs://b/a3.pdf', name: 'later.pdf', content_type: 'application/pdf' };

function makeStory(attachments: Att[]): KanbanStory {
  return {
    id: 's1', story_number: 1, title: 'Story', status: 'backlog', priority: 'medium',
    story_points: null, assignee_id: null, epic_id: null, sprint_id: null,
    description: null, acceptance_criteria: null, attachments: attachments as KanbanStory['attachments'], position: null,
    success_hypothesis: null, metric_definition: null, measure_after: null, outcome_status: 'n_a', outcome_result: null,
  };
}

let container: HTMLDivElement;
let root: Root;
let patches: { attachments: Att[]; keepalive: boolean }[];
let failPatch: (n: number) => boolean;
let setStoryOutside: ((s: KanbanStory) => void) | null;

let addToastOutside: ((t: { title: string }) => void) | null = null;
// 테스트가 밖에서 부모 상태(첨부 더하기) · 토스트를 건드릴 수 있게 — 렌더 중이 아니라 effect에서 넘긴다.
const exposeAddToast = (f: (t: { title: string }) => void) => { addToastOutside = f; };
const exposeSetStory = (f: (s: KanbanStory) => void) => { setStoryOutside = f; };

function ToastRenderer() {
  const { toasts, addToast, dismissToast } = useToast();
  useEffect(() => { exposeAddToast(addToast); }, [addToast]);
  return <ToastContainer toasts={toasts} onDismiss={dismissToast} />;
}

function Harness({ initial, show = true }: { initial: Att[]; show?: boolean }) {
  const [story, setStory] = useState(() => makeStory(initial));
  useEffect(() => { exposeSetStory(setStory); }, []);
  return show ? <StoryDetailPanel story={story} tasks={[]} onClose={() => {}} onStoryUpdate={setStory} /> : null;
}

function render(node: React.ReactNode) {
  return act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ToastProvider>
          {node}
          <ToastRenderer />
        </ToastProvider>
      </NextIntlClientProvider>,
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  patches = [];
  failPatch = () => false;
  setStoryOutside = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/stories/s1' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as { attachments: Att[] };
      patches.push({ attachments: body.attachments, keepalive: init.keepalive === true });
      if (failPatch(patches.length)) return { ok: false, json: async () => null };
      return { ok: true, json: async () => ({ data: makeStory(body.attachments) }) };
    }
    return { ok: false, json: async () => null };
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const names = () => [...container.querySelectorAll('button[aria-label="첨부 삭제"]')].map((b) => b.parentElement!.textContent ?? '');
const shown = (a: Att) => names().some((t) => t.includes(a.name));
const removeBtnOf = (a: Att) => [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="첨부 삭제"]')].find((b) => (b.parentElement!.textContent ?? '').includes(a.name))!;
const toastEl = () => container.querySelector<HTMLElement>('[role="status"], [role="alert"]');
const undoBtn = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '되돌리기');
const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

async function removeA1() {
  await render(<Harness initial={[A1, A2]} />);
  await settle();
  expect(shown(A1)).toBe(true);
  await act(async () => { removeBtnOf(A1).click(); });
}

describe('StoryDetailPanel 첨부 삭제 되돌리기([SID:4345])', () => {
  it('누르면 곧바로 숨기고 토스트(«첨부를 삭제했어요» · 파일 이름 한 줄 · «되돌리기») — 아직 PATCH 0', async () => {
    await removeA1();
    expect(shown(A1)).toBe(false);
    expect(shown(A2)).toBe(true);
    expect(toastEl()?.textContent).toContain('첨부를 삭제했어요');
    expect(toastEl()?.textContent).toContain('report.pdf');
    expect([...toastEl()!.querySelectorAll('p')].find((p) => p.textContent === 'report.pdf')?.className).toContain('truncate');
    expect(undoBtn()).toBeTruthy();
    expect(patches).toHaveLength(0);
  });

  it('첨부 ✕ 누르는 자리 24×24(아이콘 size-3 그대로 · p-1.5) · 모서리 자리 그대로 바깥쪽(-right-1 -top-1)', async () => {
    await render(<Harness initial={[A1, A2]} />);
    await settle();
    const tokens = removeBtnOf(A1).className.split(/\s+/);
    expect(tokens).toEqual(expect.arrayContaining(['min-h-6', 'min-w-6', 'p-1.5', '-right-1', '-top-1']));
    expect(tokens).not.toContain('min-h-0');
    expect(removeBtnOf(A1).querySelector('svg')?.getAttribute('class')).toContain('size-3');
  });

  it('되돌리기 → 원상 · PATCH 0(요청 취소) · 시간이 지나도 0', async () => {
    await removeA1();
    await act(async () => { undoBtn()!.click(); });
    await settle();
    expect(shown(A1)).toBe(true);
    await advance(20000);
    expect(patches).toHaveLength(0);
  });

  it('토스트가 닫히면(8초) PATCH 1 — 그때의 최신 목록에서 그 url만 뺀다', async () => {
    await removeA1();
    await advance(7999);
    expect(patches).toHaveLength(0);
    await advance(2);
    await settle();
    expect(patches).toEqual([{ attachments: [A2], keepalive: false }]);
    expect(shown(A1)).toBe(false);
  });

  it('기다리는 사이 다른 첨부가 더해지면 — 보낼 때 그것도 남는다(묵은 목록 덮기 0)', async () => {
    await removeA1();
    await act(async () => { setStoryOutside!(makeStory([A1, A2, A3])); });
    await advance(8001);
    await settle();
    expect(patches).toHaveLength(1);
    expect(patches[0].attachments.map((a) => a.url)).toEqual([A2.url, A3.url]);
  });

  it('포인터가 토스트 위에 있으면 안 닫힘 → 8.5초 지나도 PATCH 0 → 떠나면 다시 8초 뒤 PATCH 1', async () => {
    await removeA1();
    await act(async () => { toastEl()!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); toastEl()!.dispatchEvent(new PointerEvent('pointerenter')); });
    await advance(8500);
    expect(patches).toHaveLength(0);
    expect(undoBtn()).toBeTruthy();
    await act(async () => { toastEl()!.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })); toastEl()!.dispatchEvent(new PointerEvent('pointerleave')); });
    await advance(8001);
    await settle();
    expect(patches).toHaveLength(1);
  });

  it('새 토스트 다섯 장에 밀려나도(evicted) 보낸다 — 되돌리기 없이 영영 대기하지 않게', async () => {
    await removeA1();
    await act(async () => { for (let i = 0; i < 5; i += 1) addToastOutside!({ title: `다른 알림 ${i}` }); });
    await settle();
    expect(patches).toHaveLength(1);
    expect(patches[0].attachments.map((a) => a.url)).toEqual([A2.url]);
  });

  it('✕로 토스트를 닫아도 보낸다(되돌리기만 취소)', async () => {
    await removeA1();
    const close = toastEl()!.querySelector<HTMLButtonElement>('button[aria-label]')!;
    await act(async () => { close.click(); });
    await settle();
    expect(patches).toHaveLength(1);
  });

  it('대기 중 화면을 떠나면(언마운트) keepalive로 즉시 PATCH 1', async () => {
    await removeA1();
    await render(<Harness initial={[A1, A2]} show={false} />);
    await settle();
    expect(patches).toEqual([{ attachments: [A2], keepalive: true }]);
  });

  it('되돌린 뒤 떠나면 PATCH 0', async () => {
    await removeA1();
    await act(async () => { undoBtn()!.click(); });
    await render(<Harness initial={[A1, A2]} show={false} />);
    await settle();
    expect(patches).toHaveLength(0);
  });

  it('pagehide 뒤 언마운트 — 두 번 flush돼도 PATCH 1', async () => {
    await removeA1();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    await render(<Harness initial={[A1, A2]} show={false} />);
    await settle();
    expect(patches).toHaveLength(1);
    expect(patches[0].keepalive).toBe(true);
  });

  it('탭 숨김 flush(PATCH 1) → 돌아와 되돌리기 → 지금 목록에 그 한 항목만 되넣기(사이에 더한 첨부도 남음)', async () => {
    await removeA1();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    expect(patches).toEqual([{ attachments: [A2], keepalive: true }]);
    await act(async () => { setStoryOutside!(makeStory([A2, A3])); });
    await act(async () => { undoBtn()!.click(); });
    await settle();
    expect(patches).toHaveLength(2);
    expect(patches[1].attachments.map((a) => a.url)).toEqual([A1.url, A2.url, A3.url]);
    expect(shown(A1)).toBe(true);
    expect(shown(A3)).toBe(true);
  });

  it('보낸 삭제가 실패하면 다시 보이고 «첨부를 삭제하지 못했어요» 토스트', async () => {
    failPatch = () => true;
    await removeA1();
    await advance(8001);
    await settle();
    expect(patches).toHaveLength(1);
    expect(shown(A1)).toBe(true);
    expect(container.textContent).toContain('첨부를 삭제하지 못했어요. 다시 시도해 주세요.');
  });

  it('flush 뒤 되넣기가 실패하면 «첨부를 되돌리지 못했어요»(이 길에서만) · 숨긴 채', async () => {
    failPatch = (n) => n === 2;
    await removeA1();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await act(async () => { undoBtn()!.click(); });
    await settle();
    expect(patches).toHaveLength(2);
    expect(container.textContent).toContain('첨부를 되돌리지 못했어요. 다시 시도해 주세요.');
    expect(shown(A1)).toBe(false);
  });
});

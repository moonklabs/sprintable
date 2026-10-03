// @vitest-environment jsdom
//
// story #4520 AC3b (GREEN-2 live 07:14Z · Yuna 07:40Z «벨 줄 문구 — 되돌림 정본») — every person's dispatched Event carries
// `{title, body, event_type}` and no summary, so the bell drew each of them «작업 전달»: a decision request too. The bell line now
// reads summary → the carried kind's copy (the one map /inbox uses) → the server title → the old fallback. A decision request
// reads «결재 요청 · {name}» (no «게이트» word, the approvals icon, the «시스템» tab); a real hand-off stays «작업 전달».
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));
const { NotificationBell } = await import('./notification-bell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (id: string, payload: Record<string, unknown>, sourceType: string | null = null) => ({
  id, event_type: 'dispatched', source_entity_type: sourceType, source_entity_id: sourceType ? `${id}-target` : null,
  payload, read_at: null, created_at: '2026-10-03T07:14:14Z',
});
const ITEMS = [
  row('gate-named', { title: '결재 대기 중인 게이트가 있어요', body: 'agent_decision_request 게이트가 승인/거부를 기다리고 있어요.', event_type: 'gate.pending_approval', gate_name: '4520-GREEN-2' }, 'gate'),
  row('gate-unnamed', { title: '결재 대기 중인 게이트가 있어요', event_type: 'gate.pending_approval' }, 'gate'),
  row('status', { title: '스토리 상태가 바뀌었어요', event_type: 'story_status_changed' }, 'story'),
  row('mention', { title: '멘션됐어요', event_type: 'conversation.mention' }, 'conversation'),
  row('unmapped', { title: '댓글이 달렸어요', event_type: 'comment.created' }, 'story'),
  row('handoff', { title: '작업이 전달됐어요' }),
  row('summary', { summary: '미르코 · 안녕', event_type: 'gate.pending_approval', gate_name: '무시됨' }),
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/event-notifications?')) {
      return new Response(JSON.stringify({ data: ITEMS, meta: { hasMore: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ count: ITEMS.length }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openBell(locale: 'ko' | 'en' = 'ko') {
  const messages = locale === 'ko' ? koMessages : enMessages;
  await act(async () => {
    root.render(<NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul"><NotificationBell /></NextIntlClientProvider>);
  });
  const bell = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  await act(async () => { bell.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const panel = () => document.querySelector<HTMLElement>('[data-dropdown-panel="notification-bell"]')!;
const headlines = () => Array.from(panel().querySelectorAll('p.truncate.text-sm')).map((p) => p.textContent);
async function tab(label: string) {
  const button = Array.from(panel().querySelectorAll<HTMLButtonElement>('button[aria-pressed]')).find((b) => b.textContent === label)!;
  await act(async () => { button.click(); });
}

describe('NotificationBell — a dispatched line reads the kind it carries (story #4520 AC3b)', () => {
  it('a decision request reads «결재 요청 · {name}» (no «게이트») · without a name «결재 요청» · a real hand-off stays «작업 전달» · a summary still wins', async () => {
    await openBell();
    expect(headlines()).toEqual([
      '결재 요청 · 4520-GREEN-2',
      '결재 요청',
      '스토리 상태 변경',
      '새 멘션', // a kind only the /inbox label map knows
      '댓글이 달렸어요', // a kind with no copy reads the server's own title, never «작업 전달»
      '작업 전달',
      '미르코 · 안녕',
    ]);
    expect(headlines().slice(0, 2).some((h) => h?.includes('게이트'))).toBe(false);
  });

  it('tabs stay the three: a decision request is under «시스템», a story change and a real hand-off under «스토리»', async () => {
    await openBell();
    await tab('시스템');
    expect(headlines()).toEqual(['결재 요청 · 4520-GREEN-2', '결재 요청', '새 멘션', '댓글이 달렸어요', '미르코 · 안녕']);
    await tab('스토리');
    expect(headlines()).toEqual(['스토리 상태 변경', '작업 전달']);
  });

  it('en — «Approval request · {name}» · without a name «Approval request» · a real hand-off «Work handed off» (Yuna 07:40Z table)', async () => {
    await openBell('en');
    const lines = headlines();
    expect(lines[0]).toBe('Approval request · 4520-GREEN-2');
    expect(lines[1]).toBe('Approval request');
    expect(lines[5]).toBe('Work handed off');
    expect(lines.slice(0, 2).some((h) => /gate/i.test(h ?? ''))).toBe(false);
  });

  it('the decision request line wears the approvals icon, not ⚡ — ⚡ only on the real hand-off', async () => {
    await openBell();
    const icons = Array.from(panel().querySelectorAll('p.truncate.text-sm')).map(
      (p) => p.closest('button')!.querySelector('svg')!.getAttribute('class') ?? '',
    );
    expect(icons[0]).toContain('lucide-inbox');
    expect(icons[1]).toContain('lucide-inbox');
    expect(icons[5]).toContain('lucide-zap');
    expect(icons.filter((c) => c.includes('lucide-zap'))).toHaveLength(1);
  });
});

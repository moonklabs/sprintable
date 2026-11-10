// @vitest-environment jsdom
//
// story 4892 (UI-9 활동 §2) — the audit log: rows grouped by DAY (오늘 · 어제 · date), each row a button that opens its details (the original action name and the
// context key/values the hover-only tooltip used to carry). Wide (lg+): the details sit in a column beside the list; narrow: they open right under the chosen row and
// the keyboard focus moves into them (aria-expanded + aria-controls on the row; closing returns focus to the row).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ActivityLogView } from './activity-log-view';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import koMessages from '../../../messages/ko.json';

const { mq, tzMock } = vi.hoisted(() => ({ mq: { wide: true }, tzMock: { value: 'UTC' as string | null } }));
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => mq.wide }));
// the viewer's zone decides which day a row is on — pin it so the test does not depend on the machine's zone
vi.mock('@/components/viewer-time-zone', () => ({ useViewerTimeZone: () => tzMock.value }));
const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: Parameters<typeof fetchWithAuthMock>) => fetchWithAuthMock(...args) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const NOW = new Date('2026-11-10T12:00:00Z');

const row = (id: string, created_at: string, over: Record<string, unknown> = {}) => ({
  id, actor_id: 'm1', actor_name: '안나', actor_type: 'human', action: 'story.updated', entity_type: 'story', entity_title: `일감 ${id}`,
  context: { field: 'status', to: 'done' }, created_at, ...over,
});
const ITEMS = [
  row('r1', '2026-11-10T08:00:00Z'),                                   // today (UTC)
  row('r2', '2026-11-10T01:00:00Z', { context: null }),                  // today, no context
  row('r3', '2026-11-09T20:00:00Z'),                                   // yesterday
  row('r4', '2026-11-02T10:00:00Z', { action: 'doc.deleted' }),        // older
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  mq.wide = true;
  tzMock.value = 'UTC';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  fetchWithAuthMock.mockReset();
  vi.useRealTimers();
});

async function mount() {
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    return { ok: true, status: 200, json: async () => ({ data: { items: ITEMS, total: ITEMS.length, limit: 30, offset: 0 } }) };
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
        <TopBarProvider><ActivityLogView projectId="p1" /></TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
}
const rows = () => [...container.querySelectorAll('button[data-audit-row]')] as HTMLButtonElement[];
const detail = () => document.getElementById('audit-detail');
// `.click()` fires a click with detail 0 — what Enter / Space on a button produce (a keyboard activation); a mouse or touch click has detail >= 1
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await act(async () => { vi.advanceTimersByTime(5); }); };
const pointerClick = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); }); await act(async () => { vi.advanceTimersByTime(5); }); };

describe('ActivityLogView — 일 단위 묶음 (4892)', () => {
  it('⭐rows sit under day headers: 오늘 · 어제 · the date — each header is a heading with its rows', async () => {
    await mount();
    const groups = [...container.querySelectorAll('[data-testid="audit-day-group"]')];
    expect(groups.map((g) => g.querySelector('h2')?.textContent)).toEqual(['오늘', '어제', expect.stringContaining('11월')]);
    expect(groups.map((g) => g.querySelectorAll('button[data-audit-row]').length)).toEqual([2, 1, 1]);
  });
});

describe('ActivityLogView — 행을 고르면 상세가 보인다 (4892)', () => {
  it('⭐every row is a button: aria-expanded=false, no aria-controls while collapsed (nothing to point at), and no hover-only context tooltip', async () => {
    await mount();
    expect(rows()).toHaveLength(4);
    for (const r of rows()) {
      expect(r.getAttribute('aria-expanded')).toBe('false');
      expect(r.getAttribute('aria-controls')).toBeNull();
      expect(r.getAttribute('title')).toBe(r.getAttribute('aria-label'));   // the hover title only repeats the row's own words — the old tooltip's hidden facts (context) are in the details now
      expect(r.getAttribute('title')).not.toContain('field');                // …the context key/values are NOT in a tooltip
      expect(r.parentElement?.getAttribute('title')).toBeNull();
    }
    expect(detail()).toBeNull();
  });

  it('⭐wide: choosing a row shows its facts in the column beside the list — the action name and the context key/values', async () => {
    await mount();
    expect(container.textContent).toContain(koMessages.activityLog.detailPickRow);
    await click(rows()[0]!);
    expect(rows()[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(rows()[0]!.getAttribute('aria-controls')).toBe('audit-detail');   // …and once expanded it points at the region that exists
    const d = detail()!;
    expect(d).toBeTruthy();
    expect(d.closest('aside')).not.toBeNull();                 // the column beside the list
    expect(d.textContent).toContain('story.updated');           // the original action name (was tooltip-only)
    expect(d.querySelector('[data-testid="audit-detail-context"]')?.textContent).toContain('status');
    expect(d.querySelector('[data-testid="audit-detail-context"]')?.textContent).toContain('done');
    expect(d.textContent).toContain('일감 r1');                 // target
    expect(d.textContent).toContain('안나');                    // actor
    expect(container.querySelectorAll('#audit-detail')).toHaveLength(1);
  });

  it('a row without context says so; choosing the same row again closes the details; choosing another moves them', async () => {
    await mount();
    await click(rows()[1]!);
    expect(detail()!.textContent).toContain(koMessages.activityLog.detailNoContext);
    await click(rows()[0]!);
    expect(rows()[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(rows()[1]!.getAttribute('aria-expanded')).toBe('false');
    expect(detail()!.textContent).toContain('일감 r1');
    await click(rows()[0]!);
    expect(rows()[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(detail()).toBeNull();
  });

  it('⭐narrow: the details open right under the chosen row (not in a side column), once, and the keyboard focus moves into them', async () => {
    mq.wide = false;
    await mount();
    await click(rows()[2]!);
    const d = detail()!;
    expect(d).toBeTruthy();
    expect(d.closest('aside')).toBeNull();
    expect(rows()[2]!.parentElement!.parentElement!.contains(d)).toBe(true);   // inside the same list item (row layer + overlay button, then the details)
    expect(container.querySelectorAll('#audit-detail')).toHaveLength(1);
    expect(document.activeElement).toBe(d);                              // focus continues into the details
    expect(d.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.tagName).toBe('H2');
  });

  it('⭐narrow: closing the details returns the focus to the row that opened them', async () => {
    mq.wide = false;
    await mount();
    await click(rows()[3]!);
    const close = detail()!.querySelector(`button[aria-label="${koMessages.activityLog.detailClose}"]`) as HTMLButtonElement;
    expect(close).toBeTruthy();
    await click(close);
    expect(detail()).toBeNull();
    expect(rows()[3]!.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(rows()[3]);
  });
});

describe('ActivityLogView — 목록이 바뀌면 고른 행이 풀린다 (4892)', () => {
  it('⭐a new list (the filter changed) that no longer holds the chosen row clears the choice and the details', async () => {
    let call = 0;
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      call += 1;
      const items = call === 2 ? [row('z9', '2026-11-10T09:00:00Z')] : ITEMS;   // 1st list: all · 2nd: without r1 · 3rd: all again (r1 is back)
      return { ok: true, status: 200, json: async () => ({ data: { items, total: items.length, limit: 30, offset: 0 } }) };
    });
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
          <TopBarProvider><ActivityLogView projectId="p1" /></TopBarProvider>
        </NextIntlClientProvider>,
      );
    });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    await click(rows()[0]!);
    expect(detail()).toBeTruthy();
    // the person changes the end date → a new first page (without r1) is asked for
    const to = container.querySelector(`input[aria-label="${koMessages.activityLog.toDate}"]`) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(to, '2026-11-09');
      to.dispatchEvent(new Event('input', { bubbles: true }));
      to.dispatchEvent(new Event('change', { bubbles: true }));
    });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(detail()).toBeNull();
    expect(container.textContent).toContain(koMessages.activityLog.detailPickRow);
    // the row comes back in a later list: it must NOT re-open by itself (the stale choice was cleared, not just hidden)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(to, '2026-11-08');
      to.dispatchEvent(new Event('input', { bubbles: true }));
      to.dispatchEvent(new Event('change', { bubbles: true }));
    });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    expect(rows()).toHaveLength(4);
    expect(rows().every((r) => r.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(detail()).toBeNull();
  });
});

describe('ActivityLogView — 초점은 키보드 활성에서만 옮긴다 (4892, codex)', () => {
  it('⭐narrow + a MOUSE / touch click: the details open but the focus stays where the pointer put it (no stolen focus)', async () => {
    mq.wide = false;
    await mount();
    rows()[1]!.focus();
    await pointerClick(rows()[1]!);
    expect(detail()).toBeTruthy();
    expect(document.activeElement).toBe(rows()[1]);
    expect(document.activeElement).not.toBe(detail());
  });

  it('⭐narrow + a KEYBOARD activation (Enter / Space → click detail 0): the focus moves into the details', async () => {
    mq.wide = false;
    await mount();
    rows()[1]!.focus();
    await click(rows()[1]!);
    expect(document.activeElement).toBe(detail());
  });

  it('wide: a keyboard activation keeps the focus on the row (the details column is beside it, not in the way)', async () => {
    await mount();
    rows()[0]!.focus();
    await click(rows()[0]!);
    expect(document.activeElement).toBe(rows()[0]);
  });
});

describe('ActivityLogView — 시간대를 모를 때(null)도 묶음과 상세가 같은 날을 가리킨다 (4892, codex)', () => {
  it('⭐viewer zone unknown → both fall back to UTC: a row at 23:30 UTC on the 10th is under the 10th and its details say the 10th', async () => {
    tzMock.value = null;
    vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));   // so the row's day is an older date header, not 오늘 / 어제
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      const items = [row('late', '2026-11-10T23:30:00Z')];
      return { ok: true, status: 200, json: async () => ({ data: { items, total: 1, limit: 30, offset: 0 } }) };
    });
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <TopBarProvider><ActivityLogView projectId="p1" /></TopBarProvider>
        </NextIntlClientProvider>,
      );
    });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    expect(container.querySelector('[data-testid="audit-day-group"] h2')?.textContent).toContain('10일');
    await click(rows()[0]!);
    expect(detail()!.querySelector('dl')!.textContent).toContain('10.');   // «2026. 11. 10.» — not the 11th (what a non-UTC runtime zone would show)
    expect(detail()!.querySelector('dl')!.textContent).not.toContain('11. 11.');
  });
});

describe('ActivityLogView — 행의 구조: 단추 안에 블록이 없다 (4892, codex)', () => {
  it('⭐the visible capsule is an inert layer and the row button is an empty overlay named with the row\'s own words — agent rows included (no focusable avatar inside a button)', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      const items = [row('ag', '2026-11-10T08:00:00Z', { actor_type: 'agent', actor_name: '디버거', actor_id: 'a1' })];
      return { ok: true, status: 200, json: async () => ({ data: { items, total: 1, limit: 30, offset: 0 } }) };
    });
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
          <TopBarProvider><ActivityLogView projectId="p1" /></TopBarProvider>
        </NextIntlClientProvider>,
      );
    });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    const button = rows()[0]!;
    expect(button.querySelector('*')).toBeNull();                                  // nothing nested inside the button (no div, no focusable avatar)
    const layer = button.previousElementSibling as HTMLElement;
    expect(layer.hasAttribute('inert')).toBe(true);                                  // the visible capsule is not a tab stop and is not read twice
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    const name = button.getAttribute('aria-label')!;
    expect(name).toContain('디버거');                                                // who
    expect(name).toContain('story');                                                  // what (the claim)
    expect(name).toContain('일감 ag');
    expect(button.getAttribute('title')).toBe(name);                               // the overlay covers the row — the hover tooltip with the row's whole words lives on it
  });
});

describe('ActivityLogView — 상세의 «행위자» 줄이 사람과 에이전트를 가른다 (4892, PO)', () => {
  async function mountOne(over: Record<string, unknown>) {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      const items = [row('one', '2026-11-10T08:00:00Z', over)];
      return { ok: true, status: 200, json: async () => ({ data: { items, total: 1, limit: 30, offset: 0 } }) };
    });
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
          <TopBarProvider><ActivityLogView projectId="p1" /></TopBarProvider>
        </NextIntlClientProvider>,
      );
    });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    await click(rows()[0]!);
  }
  const actorLine = () => [...detail()!.querySelectorAll('dt')].find((d) => d.textContent === koMessages.activityLog.detailActor)!.nextElementSibling!.textContent;

  it('⭐an agent row\'s actor line carries «에이전트» (the avatar tooltip\'s distinction, now reachable)', async () => {
    await mountOne({ actor_type: 'agent', actor_name: '디버거', actor_id: 'a1' });
    expect(actorLine()).toBe(`디버거 · ${koMessages.chats.agent}`);
  });

  it('a human row\'s actor line is the name only — no «에이전트»', async () => {
    await mountOne({ actor_type: 'human', actor_name: '안나' });
    expect(actorLine()).toBe('안나');
    expect(detail()!.textContent).not.toContain(koMessages.chats.agent);
  });
});


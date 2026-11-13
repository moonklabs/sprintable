// @vitest-environment jsdom
//
// story 4911 (UI-R3) — the «실행 기록» list rebuilt on the layer rule: three groups (먼저 볼 것 · 진행 중 · 끝난 것), a status select whose default is «전체» (PO Q1), one row = one run on ListRow,
// a right-click menu with only the actions the row already has (PO Q3), keys j/k/↑/↓ + M. The same `/agent-runs` calls as before (no backend change).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TopBarProvider } from '@/components/nav/top-bar-context';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

import { AgentRunsList, groupRuns } from './agent-runs-list';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = koMessages.agentRuns;
let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <TopBarProvider>{node}</TopBarProvider>
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  useDashboardContextMock.mockReturnValue({ projectId: 'proj-1' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
}

let n = 0;
type Run = Parameters<typeof groupRuns>[0][number];
function run(status: Run['status'], extra: Partial<Run> = {}): Run {
  n += 1;
  return {
    id: `r${n}`, agent_id: 'a1', agent_name: `에이전트${n}`, deployment_id: null, session_id: null, memo_id: null, story_id: null, trigger: 'memo', model: 'm', llm_provider: null, llm_provider_key: null,
    status, duration_ms: 1200, llm_call_count: 1, input_tokens: 10, output_tokens: 5, cost_usd: 0.01, computed_cost_cents: 1, per_run_cap_cents: null, billing_notes: [], result_summary: `결과${n}`,
    error_message: null, last_error_code: null, retry_count: null, max_retries: null, next_retry_at: null, failure_disposition: null, started_at: null, finished_at: null,
    created_at: new Date(Date.UTC(2026, 10, 12, 0, 0, 0) + n * 60000).toISOString(), ...extra,
  };
}

type Handler = (status: string | null) => { status: number; items?: Run[] };
function stubRuns(handler: Handler) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://test');
    const { status, items } = handler(url.searchParams.get('status'));
    return { ok: status >= 200 && status < 300, status, json: async () => ({ data: items ?? [], meta: null }) } as Response;
  }));
}

const sectionTitles = () => Array.from(container.querySelectorAll('[data-testid="agent-runs-section"] h2')).map((h) => h.textContent ?? '');
const rowKeys = (scope: ParentNode = container) => Array.from(scope.querySelectorAll('[data-row-key]')).map((r) => r.getAttribute('data-row-key'));

describe('groupRuns — 먼저 볼 것 / 진행 중 / 끝난 것', () => {
  it('⭐실패 · 사람 확인 대기는 «먼저 볼 것», 진행 중(실행 중 · 대기 · 보류)은 «진행 중», 나머지는 «끝난 것» — 최신순, 한 건은 한 칸에만', () => {
    const f = run('failed'); const h = run('hitl_pending'); const r = run('running'); const q = run('queued'); const d = run('completed'); const a = run('abandoned');
    const g = groupRuns([d, a, r, q, f, h], null, null);
    expect(g.attention.map((x) => x.id)).toEqual([h.id, f.id]); // newest first
    expect(g.progress.map((x) => x.id).sort()).toEqual([r.id, q.id].sort());
    expect(g.done.map((x) => x.id).sort()).toEqual([d.id, a.id].sort());
  });

  it('⭐실패 · 확인 대기 전용 호출이 있으면 «전체» 첫 쪽 밖의 것도 «먼저 볼 것»에 오른다(긴 완료 목록이 밀어내지 못함) — 같은 건이 둘 다에 있어도 한 번만', () => {
    const farFailed = run('failed'); const dup = run('failed'); const done = run('completed');
    const g = groupRuns([done, dup], [farFailed, dup], [dup]); // the same run is in BOTH dedicated lists
    expect(g.attention.map((x) => x.id).sort()).toEqual([farFailed.id, dup.id].sort()); // …and is listed once
    expect(g.done.map((x) => x.id)).toEqual([done.id]);
  });

  it('⭐실패 · 확인 대기 건이 «더 보기»로 불러온 뒤쪽 쪽에만 있어도(전용 호출 첫 쪽 밖) «먼저 볼 것»에 남는다 — 어느 칸에서도 사라지지 않음(codex 01a1d535)', () => {
    const recent = run('failed'); const older = run('failed'); const olderWait = run('hitl_pending'); const done = run('completed');
    const g = groupRuns([done, older, olderWait], [recent], []);   // the dedicated first pages hold only `recent`; the main list's later page holds the older ones
    expect(g.attention.map((x) => x.id).sort()).toEqual([recent.id, older.id, olderWait.id].sort());
    expect(g.done.map((x) => x.id)).toEqual([done.id]);
    const total = g.attention.length + g.progress.length + g.done.length;
    expect(total).toBe(4);   // every run of the union is in exactly one group
  });

  it('⭐전용 호출 둘이 «전체» 첫 쪽에 없는 실패 · 확인 대기 건을 각자 가져온다 — 둘 다 «먼저 볼 것»에 오른다(전용 목록 하나라도 버리면 그 건이 사라짐)', () => {
    const farFailed = run('failed'); const farWait = run('hitl_pending'); const done = run('completed');
    const g = groupRuns([done], [farFailed], [farWait]);           // neither far run is in the main list at all
    expect(g.attention.map((x) => x.id).sort()).toEqual([farFailed.id, farWait.id].sort());
    expect(g.done.map((x) => x.id)).toEqual([done.id]);
  });

  it('전용 호출이 실패(null)하면 «전체» 목록에 이미 있는 실패 · 확인 대기로 대신한다(아무것도 숨기지 않음)', () => {
    const f = run('failed'); const h = run('hitl_pending'); const d = run('completed');
    expect(groupRuns([f, h, d], null, null).attention.map((x) => x.id).sort()).toEqual([f.id, h.id].sort());
  });
});

describe('AgentRunsList — 화면 구조(story 4911)', () => {
  it('⭐기본 «전체»: 세 칸이 «먼저 볼 것 → 진행 중 → 끝난 것» 순서로, 칸마다 제 머리글 · 건수', async () => {
    const f = run('failed'); const r = run('running'); const d = run('completed');
    stubRuns((s) => ({ status: 200, items: s === 'failed' ? [f] : s === 'hitl_pending' ? [] : [d, r, f] }));
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();
    expect(sectionTitles().map((t) => t.replace(/\d+$/, ''))).toEqual([T.sectionAttention, T.sectionProgress, T.sectionDone]);
    const sections = Array.from(container.querySelectorAll('[data-testid="agent-runs-section"]'));
    expect(sections.map((s) => rowKeys(s))).toEqual([[f.id], [r.id], [d.id]]);
  });

  it('⭐상태 선택(select)의 기본값은 «전체»(옛 기본 «완료»가 실패를 필터 뒤에 숨기던 것을 되돌리지 않음)', async () => {
    stubRuns(() => ({ status: 200, items: [] }));
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();
    const select = container.querySelector(`select[aria-label="${T.statusFilterLabel}"]`) as HTMLSelectElement;
    expect(select.value).toBe('all');
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels[0]).toBe(T.filterAll);
    expect(labels.slice(1).sort()).toEqual([T.status_completed, T.status_failed, T.status_hitl_pending, T.status_running, T.status_queued, T.status_held, T.status_abandoned].sort());
  });

  it('⭐한 줄 = 한 실행: 상태는 글자가 있는 칩, 실패 줄은 왼쪽 막대, 제목은 에이전트 이름 · 한 줄 요약, 접근 이름은 «이름 · 상세 보기»', async () => {
    const f = run('failed', { agent_name: '민', error_message: 'boom', last_error_code: null });
    stubRuns((s) => ({ status: 200, items: s === 'hitl_pending' ? [] : [f] }));
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();
    const row = container.querySelector(`[data-row-key="${f.id}"]`) as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain(T.status_failed);
    expect(row.querySelector('[data-row-focus]')?.getAttribute('aria-label')).toMatch(new RegExp(`^민 · ${T.status_failed} · .+ · ${T.openDetail}$`));
    expect(row.querySelector('[data-row-focus]')?.textContent).toContain('민');
    expect(row.innerHTML).toContain('before:bg-ds-failed');
  });

  it('⭐상태 칩의 색은 카탈로그(lib/agent-run-status)의 뜻을 따른다 — 끝남=done · 실패=failed · 확인 대기 · 미완=needs-hand · 실행 중=info · 대기 · 보류=neutral, 글자는 늘 함께', async () => {
    const all = (['completed', 'failed', 'hitl_pending', 'abandoned', 'running', 'queued', 'held'] as const).map((st) => run(st));
    stubRuns((s) => ({ status: 200, items: s === 'failed' ? all.filter((r) => r.status === 'failed') : s === 'hitl_pending' ? all.filter((r) => r.status === 'hitl_pending') : all }));
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();
    const tone = (st: string) => container.querySelector(`[data-row-key="${all.find((r) => r.status === st)!.id}"] [data-slot="ds-chip"]`)?.getAttribute('data-tone');
    expect(tone('completed')).toBe('done');
    expect(tone('failed')).toBe('failed');
    expect(tone('hitl_pending')).toBe('needs-hand');
    expect(tone('abandoned')).toBe('needs-hand');
    expect(tone('running')).toBe('info');
    expect(tone('queued')).toBe('neutral');
    expect(tone('held')).toBe('neutral');
    for (const st of ['completed', 'failed', 'abandoned']) {
      expect(container.querySelector(`[data-row-key="${all.find((r) => r.status === st)!.id}"] [data-slot="ds-chip"]`)?.textContent).toBe((T as Record<string, string>)[`status_${st}`]);
    }
  });

  it('⭐같은 에이전트의 실행 둘은 접근 이름이 서로 다르다(상태 · 시작 시각이 이름에 들어감) — 같은 «상세 보기»가 줄마다 반복되지 않음(codex 01a1d535 · story 3592)', async () => {
    const a = run('completed', { agent_name: '민', created_at: '2026-11-12T00:00:01.000Z' }); const b = run('completed', { agent_name: '민', created_at: '2026-11-12T00:00:09.000Z' });
    stubRuns((s) => ({ status: 200, items: s === 'failed' || s === 'hitl_pending' ? [] : [b, a] }));
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();
    const names = Array.from(container.querySelectorAll('[data-row-focus]')).map((el) => el.getAttribute('aria-label'));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  it('⭐«전체»에서 실패 전용 호출만 실패하면: 그 칸에 불러오기 실패 안내 + 다시 시도, 전체 목록에 있는 실패 건은 그대로 보인다(숨기지도 꾸미지도 않음)', async () => {
    const f = run('failed'); const d = run('completed');
    stubRuns((s) => (s === 'failed' ? { status: 500 } : { status: 200, items: s === 'hitl_pending' ? [] : [d, f] }));
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();
    const attention = container.querySelectorAll('[data-testid="agent-runs-section"]')[0];
    expect(attention.querySelector('[role="alert"]')?.textContent).toContain(T.sectionLoadError);
    expect(rowKeys(attention)).toEqual([f.id]);
  });

  it('⭐«전체» 목록 호출이 실패하면 오류 얼굴(빈 목록으로 위장하지 않음)', async () => {
    stubRuns((s) => (s === null ? { status: 500 } : { status: 200, items: [] }));
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();
    expect(container.textContent).toContain(koMessages.common.error);
    expect(container.querySelectorAll('[data-testid="agent-runs-section"]')).toHaveLength(0);
    expect(container.textContent).not.toContain(T.emptyTitle);
  });

  it('⭐상태를 고르면 칸 나눔 없이 한 칸 평평한 목록', async () => {
    const f = run('failed');
    stubRuns((s) => ({ status: 200, items: s === 'failed' ? [f] : [] }));
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();
    const select = container.querySelector(`select[aria-label="${T.statusFilterLabel}"]`) as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(select, 'failed'); select.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    expect(sectionTitles().map((t) => t.replace(/\d+$/, ''))).toEqual([T.status_failed]);
    expect(rowKeys()).toEqual([f.id]);
  });
});

describe('AgentRunsList — 키 · 우클릭(story 4911, PO Q3: 열기 · 메모 열기 둘만)', () => {
  it('⭐j/↓ 는 다음 줄 제목으로 포커스, k/↑ 는 앞 줄', async () => {
    const a = run('failed'); const b = run('completed');
    stubRuns((s) => ({ status: 200, items: s === 'failed' ? [a] : s === 'hitl_pending' ? [] : [b, a] }));
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();
    const titleOf = (id: string) => container.querySelector(`[data-row-key="${id}"] [data-row-focus]`) as HTMLElement;
    titleOf(a.id).focus();
    await act(async () => { titleOf(a.id).dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })); });
    expect(document.activeElement).toBe(titleOf(b.id));
    await act(async () => { titleOf(b.id).dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true })); });
    expect(document.activeElement).toBe(titleOf(a.id));
  });

  it('⭐M 은 포커스한 줄의 트리거 메모 링크를 누른다(링크가 없는 줄에선 아무 일도 없음)', async () => {
    const a = run('failed', { memo_id: 'memo-9' }); const b = run('completed');
    stubRuns((s) => ({ status: 200, items: s === 'failed' ? [a] : s === 'hitl_pending' ? [] : [b, a] }));
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();
    const clicked: string[] = [];
    const onClick = (e: Event) => { const el = (e.target as HTMLElement).closest('a[data-memo-link]'); if (el) { e.preventDefault(); clicked.push(el.getAttribute('href') ?? ''); } };
    document.addEventListener('click', onClick, true);
    try {
      const titleOf = (id: string) => container.querySelector(`[data-row-key="${id}"] [data-row-focus]`) as HTMLElement;
      await act(async () => { titleOf(b.id).dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true })); });
      expect(clicked).toEqual([]);
      await act(async () => { titleOf(a.id).dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true })); });
      expect(clicked).toEqual(['/memos?id=memo-9']);
    } finally {
      document.removeEventListener('click', onClick, true);
    }
  });

  it('⭐우클릭 메뉴: «열기» + (메모가 있는 줄만) «트리거 메모 열기» — 그 밖의 항목 없음', async () => {
    const a = run('failed', { memo_id: 'memo-9' }); const b = run('completed');
    stubRuns((s) => ({ status: 200, items: s === 'failed' ? [a] : s === 'hitl_pending' ? [] : [b, a] }));
    await act(async () => { root.render(wrap(<AgentRunsList />)); });
    await flush();
    const openMenuOn = async (id: string) => {
      const row = container.querySelector(`[data-row-key="${id}"]`) as HTMLElement;
      await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
      await flush();
      return Array.from(document.body.querySelectorAll('[role="menuitem"]')).map((m) => m.textContent);
    };
    expect(await openMenuOn(a.id)).toEqual([T.menuOpen, T.menuOpenMemo]);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await flush();
    expect(await openMenuOn(b.id)).toEqual([T.menuOpen]);
  });
});

describe('실행 기록 목록은 화면 층 규칙의 토큰을 쓴다 (story 4911)', () => {
  const src = readFileSync(join(__dirname, 'agent-runs-list.tsx'), 'utf8');

  it('⭐줄은 층 토큰 LAYER.rowOthers, 칸은 내용 칸 층 LAYER.panel — 맨글로 바탕에 서지 않는다', () => {
    expect(src).toContain("import { LAYER } from '@/components/ds/layers'");
    // the faces are named once (`AGENT_RUNS_*_FACE`, pinned by styles/layer-rule.test.ts) and the markup uses those names
    expect(src).toContain('export const AGENT_RUNS_ROW_FACE = LAYER.rowOthers;');
    expect(src).toContain('export const AGENT_RUNS_PANEL_FACE = LAYER.panel;');
    expect(src).toContain('${AGENT_RUNS_ROW_FACE}');
    expect(src).toContain('${AGENT_RUNS_PANEL_FACE}');
  });

  it('⭐줄 · 칸 · 칩은 ds 부품(ListRow · SectionHeader · Chip) — 옛 손 만든 카드 · 칩(bg-muted · text-muted-foreground · 손 만든 rounded-full 칩) 0', () => {
    for (const part of ["from '@/components/ds/list-row'", "from '@/components/ds/section-header'", "from '@/components/ds/chip'", "from '@/components/ds/menu'", "from '@/components/ds/select'"]) expect(src, part).toContain(part);
    for (const legacy of ['bg-muted', 'text-muted-foreground', 'bg-card', 'rounded-full']) expect(src, legacy).not.toContain(legacy);
  });
});

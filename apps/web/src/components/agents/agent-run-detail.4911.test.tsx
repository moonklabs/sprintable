// @vitest-environment jsdom
//
// story 4911 (UI-R3) — the run detail rebuilt on ds parts and the layer rule: ONE content panel (status · times · chips → the numbers as one strip → who paid as one list → the error as a failed Banner → the result),
// a «목록으로» head, the status chip's colour from the catalog, no four stat cards / five meta cards. The same `/agent-runs/{id}` call as before (no backend change).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TopBarProvider, useTopBar } from '@/components/nav/top-bar-context';
import { AgentRunDetail, AGENT_RUN_DETAIL_PANEL_FACE, AGENT_RUN_DETAIL_STRIP_FACE } from './agent-run-detail';
import { LAYER } from '@/components/ds/layers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = koMessages.agentRuns;
let container: HTMLDivElement;
let root: Root;

type RunOverrides = Record<string, unknown>;
function runBody(extra: RunOverrides = {}) {
  return {
    id: 'run-4911-abcdef', agent_id: 'agent-1', agent_name: '민', deployment_id: null, memo_id: null, story_id: null, trigger: 'manual', model: 'claude-x',
    llm_provider: 'managed', llm_provider_key: 'anthropic', status: 'completed', duration_ms: 1200, llm_call_count: 3, input_tokens: 100, output_tokens: 50, cost_usd: 0.0123,
    computed_cost_cents: 2, per_run_cap_cents: 50, billing_notes: [], result_summary: '결과 한 줄', error_message: null, last_error_code: null, retry_count: null, max_retries: null,
    next_retry_at: null, failure_disposition: null, started_at: '2026-11-12T00:00:00Z', finished_at: '2026-11-12T00:00:02Z', created_at: '2026-11-12T00:00:00Z', ...extra,
  };
}

function stubFetch(run: RunOverrides = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/tool-calls')) return { ok: true, status: 200, json: async () => ({ data: [], meta: { total_count: 0 } }) } as Response;
    return { ok: true, status: 200, json: async () => ({ data: runBody(run) }) } as Response;
  }));
}

// what the top bar would show: the slot's title (the page's h1) and whether it asks for the org/project context chip
function SlotProbe() {
  const { title, showContextChip } = useTopBar();
  return (<><div data-testid="slot-title">{title}</div><i data-testid="slot-chip" data-chip={String(showContextChip)} /></>);
}

async function renderDetail(onBack: () => void = () => {}) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider><SlotProbe /><AgentRunDetail runId="run-4911-abcdef" locale="ko" onBack={onBack} /></TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

const q = (sel: string) => container.querySelector(sel);
const panel = () => q('[data-testid="agent-run-detail-panel"]') as HTMLElement;

describe('AgentRunDetail — 한 장의 내용 칸(story 4911)', () => {
  it('⭐머리 = «목록으로» + 실행 id, 그 아래 내용 칸 하나 — 상태 칩 · 시각 · 숫자 한 줄 · 결제 한 묶음 · 결과', async () => {
    stubFetch();
    await renderDetail();
    expect(q('[data-testid="run-detail-back"]')?.textContent).toContain(T.backToList);
    expect(container.textContent).toContain('run-4911');
    expect(container.querySelectorAll('[data-testid="agent-run-detail-panel"]')).toHaveLength(1);
    const chip = panel().querySelector('[data-slot="ds-chip"]');
    expect(chip?.textContent).toBe(T.status_completed);
    expect(chip?.getAttribute('data-tone')).toBe('done');
    expect(panel().textContent).toContain(T.startedAt);
    expect(panel().textContent).toContain(T.finishedAt);
    expect(panel().textContent).toContain('결과 한 줄');
  });

  it('⭐숫자 넷은 카드 넷이 아니라 한 묶음(dl) — 시간 · LLM 호출 · 토큰 · 비용 — 값은 그대로', async () => {
    stubFetch();
    await renderDetail();
    const strip = q('[data-testid="agent-run-detail-stats"]') as HTMLElement;
    expect(strip.tagName).toBe('DL');
    expect(Array.from(strip.querySelectorAll('dt')).map((e) => e.textContent)).toEqual([T.duration, T.llmCallsLabel, T.tokens, T.cost]);
    expect(Array.from(strip.querySelectorAll('dd')).map((e) => e.textContent)).toEqual(['1.2s', '3', '100 / 50', '$0.0123']);
  });

  it('⭐결제 정보 다섯은 카드 다섯이 아니라 한 목록(dl) — provider · 결제 방식 · 모델 · 계산 비용 · 한도', async () => {
    stubFetch();
    await renderDetail();
    const meta = q('[data-testid="agent-run-detail-meta"]') as HTMLElement;
    expect(meta.tagName).toBe('DL');
    expect(Array.from(meta.querySelectorAll('dt')).map((e) => e.textContent)).toEqual([T.providerLabel, T.billingModeLabel, T.modelLabel, T.computedCostLabel, T.perRunCapLabel]);
    expect(Array.from(meta.querySelectorAll('dd')).map((e) => e.textContent)).toEqual(['anthropic', T.billingMode_managed, 'claude-x', '2¢', '50¢']);
  });

  it('값이 없으면 «-»(없는 값을 꾸며 내지 않음)', async () => {
    stubFetch({ llm_provider: null, llm_provider_key: null, model: null, per_run_cap_cents: null, cost_usd: null, duration_ms: null, result_summary: null, finished_at: null });
    await renderDetail();
    const dd = Array.from((q('[data-testid="agent-run-detail-meta"]') as HTMLElement).querySelectorAll('dd')).map((e) => e.textContent);
    expect(dd).toEqual(['-', '-', '-', '2¢', '-']);
    expect(Array.from((q('[data-testid="agent-run-detail-stats"]') as HTMLElement).querySelectorAll('dd')).map((e) => e.textContent)).toEqual(['-', '3', '100 / 50', '-']);
    expect(panel().textContent).not.toContain(T.resultSummary);
    expect(panel().textContent).not.toContain(T.finishedAt);
  });

  it('⭐결제 메모가 있으면 칩으로, 없으면 이름표도 안 나옴', async () => {
    stubFetch({ billing_notes: ['byom_key', 'cap_hit'] });
    await renderDetail();
    expect(panel().textContent).toContain(T.billingNotesLabel);
    expect(Array.from(panel().querySelectorAll('[data-slot="ds-chip"]')).map((e) => e.textContent)).toEqual(expect.arrayContaining(['byom_key', 'cap_hit']));
  });

  it('⭐실패 run: 실패 Banner(role=alert · data-tone=failed)에 오류 글 · 오류 코드, 칩은 failed 톤 + «재시도 예정» 칩과 다음 시각', async () => {
    stubFetch({ status: 'failed', error_message: '실패했습니다', last_error_code: 'E1', failure_disposition: 'retry_scheduled', retry_count: 1, max_retries: 3, next_retry_at: '2026-11-13T00:00:00Z' });
    await renderDetail();
    const banner = panel().querySelector('[data-slot="ds-banner"]') as HTMLElement;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.getAttribute('data-tone')).toBe('failed');
    expect(banner.textContent).toContain(T.errorLabel);
    expect(banner.textContent).toContain('E1');
    expect(banner.textContent).toContain(T.nextRetryAt);
    expect(panel().querySelector('[data-slot="ds-chip"]')?.getAttribute('data-tone')).toBe('failed');
    expect(panel().textContent).toContain(T.failureDisposition_retry_scheduled);
  });

  it('성공한 run엔 실패 Banner가 없다', async () => {
    stubFetch();
    await renderDetail();
    expect(panel().querySelector('[data-slot="ds-banner"]')).toBeNull();
  });

  it('⭐«목록으로»는 onBack을 부른다', async () => {
    stubFetch();
    const onBack = vi.fn();
    await renderDetail(onBack);
    await act(async () => { (q('[data-testid="run-detail-back"]') as HTMLButtonElement).click(); });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('⭐상태 칩 색은 카탈로그를 따른다 — 확인 대기 · 미완 = needs-hand · 실행 중 = info · 대기 = neutral', async () => {
    for (const [status, tone] of [['hitl_pending', 'needs-hand'], ['abandoned', 'needs-hand'], ['running', 'info'], ['queued', 'neutral']] as const) {
      stubFetch({ status });
      await renderDetail();
      expect(panel().querySelector('[data-slot="ds-chip"]')?.getAttribute('data-tone'), status).toBe(tone);
      await act(async () => { root.unmount(); });
      container.remove();
      container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    }
  });

  it('⭐상단바 제목 = 이 페이지의 h1(«실행 상세 · 에이전트 이름») · 상세 화면이라 맥락 칩은 안 켬(codex 01a1d58c)', async () => {
    stubFetch();
    await renderDetail();
    const h1 = q('[data-testid="slot-title"] h1');
    expect(h1?.textContent).toBe(`${T.detailEyebrow} · 민`);
    expect(q('[data-testid="slot-chip"]')?.getAttribute('data-chip')).toBe('false');
    expect(container.querySelectorAll('h1')).toHaveLength(1);   // the only h1 of the page
  });

  it('⭐불러오는 중 · 불러오기 실패 · 빈 얼굴에서도 상단바 제목(h1)과 «목록으로»가 있다 — 제목이 사라지지 않고 되돌아갈 눈에 보이는 길이 남음(codex 01a1d58c)', async () => {
    const onBack = vi.fn();
    // loading: the run call never answers
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    await renderDetail(onBack);
    expect(q('[data-testid="slot-title"] h1')?.textContent).toBe(T.detailEyebrow);
    expect(q('[data-testid="run-detail-back"]')).not.toBeNull();
    // load error
    await act(async () => { root.unmount(); });
    container.remove(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response));
    await renderDetail(onBack);
    expect(q('[role="alert"]')).not.toBeNull();
    expect(q('[data-testid="slot-title"] h1')?.textContent).toBe(T.detailEyebrow);
    expect(q('[data-testid="run-detail-back"]')).not.toBeNull();
    await act(async () => { (q('[data-testid="run-detail-back"]') as HTMLButtonElement).click(); });
    expect(onBack).toHaveBeenCalledTimes(1);
    // empty (the call answered, no run)
    await act(async () => { root.unmount(); });
    container.remove(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: null }) }) as Response));
    await renderDetail(onBack);
    expect(container.textContent).toContain(koMessages.common.noData);
    expect(q('[data-testid="slot-title"] h1')?.textContent).toBe(T.detailEyebrow);
    expect(q('[data-testid="run-detail-back"]')).not.toBeNull();
  });

  it('⭐다른 실행으로 바뀌어 불러오는 동안 앞 실행의 이름 · id가 제목과 머리에 남지 않는다(codex 01a1d59c)', async () => {
    let release: (v: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/tool-calls')) return { ok: true, status: 200, json: async () => ({ data: [], meta: { total_count: 0 } }) } as Response;
      if (url.includes('run-B')) return new Promise<Response>((r) => { release = r; });
      return { ok: true, status: 200, json: async () => ({ data: runBody({ id: 'run-A-zzzzzzzz', agent_name: '앞 실행 에이전트' }) }) } as Response;
    }));
    const mount = (id: string) => (
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider><SlotProbe /><AgentRunDetail runId={id} locale="ko" onBack={() => {}} /></TopBarProvider>
      </NextIntlClientProvider>
    );
    await act(async () => { root.render(mount('run-A')); });
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
    expect(q('[data-testid="slot-title"] h1')?.textContent).toContain('앞 실행 에이전트');
    await act(async () => { root.render(mount('run-B')); });
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    expect(q('[data-testid="slot-title"] h1')?.textContent).toBe(T.detailEyebrow);   // loading run B: no run A name
    expect(container.textContent).not.toContain('run-A-zz');
    expect(container.textContent).not.toContain('앞 실행 에이전트');
    release({ ok: true, status: 200, json: async () => ({ data: runBody({ id: 'run-B-yyyyyyyy', agent_name: '새 실행 에이전트' }) }) } as Response);
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
    expect(q('[data-testid="slot-title"] h1')?.textContent).toContain('새 실행 에이전트');
  });

  it('⭐같은 실행을 다시 그려도 상단바 제목 요소는 그대로(렌더마다 슬롯을 지우고 다시 세우지 않음) — codex 01a1d59c', async () => {
    stubFetch();
    const seen = new Set<unknown>();
    function TitleSpy() { const { title } = useTopBar(); seen.add(title); return null; }
    const mount = () => (
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TopBarProvider><TitleSpy /><AgentRunDetail runId="run-4911-abcdef" locale="ko" onBack={() => {}} /></TopBarProvider>
      </NextIntlClientProvider>
    );
    await act(async () => { root.render(mount()); });
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
    const settled = seen.size;
    await act(async () => { root.render(mount()); });      // the same props again
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    expect(seen.size).toBe(settled);
  });

  it('도구 호출 구역은 그대로 붙어 있다(이 PR은 층만 — 안쪽은 다음)', async () => {
    stubFetch();
    await renderDetail();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/tool-calls'))).toBe(true);
  });
});

describe('실행 상세는 화면 층 규칙의 토큰을 쓴다 · 옛 부품 0 (story 4911)', () => {
  const src = readFileSync(join(__dirname, 'agent-run-detail.tsx'), 'utf8');

  it('⭐칸은 내용 칸 층 · 숫자 묶음은 글 줄 층 — 이름을 한 번 짓고 마크업이 그 이름을 쓴다', () => {
    expect(AGENT_RUN_DETAIL_PANEL_FACE).toBe(LAYER.panel);
    expect(AGENT_RUN_DETAIL_STRIP_FACE).toBe(LAYER.rowOthers);
    expect(src).toContain('export const AGENT_RUN_DETAIL_PANEL_FACE = LAYER.panel;');
    expect(src).toContain('export const AGENT_RUN_DETAIL_STRIP_FACE = LAYER.rowOthers;');
    expect(src).toContain('${AGENT_RUN_DETAIL_PANEL_FACE}');
    expect(src).toContain('${AGENT_RUN_DETAIL_STRIP_FACE}');
  });

  it('⭐옛 손 만든 카드 · 칩 · 알림 · 헤더(StatCard · MetaCard · SectionCard · PageHeader · Badge · Alert · overlay-fill · bg-muted) 0 — ds 부품(Chip · Banner · Button)', () => {
    for (const legacy of ['StatCard', 'MetaCard', 'SectionCard', 'PageHeader', '<Badge', '<Alert', 'overlay-fill', 'overlay-line', 'bg-muted', 'text-muted-foreground', 'rounded-xl']) expect(src, legacy).not.toContain(legacy);
    for (const part of ["from '@/components/ds/chip'", "from '@/components/ds/banner'", "from '@/components/ds/button'"]) expect(src, part).toContain(part);
  });
});

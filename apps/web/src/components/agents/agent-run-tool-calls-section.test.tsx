// @vitest-environment jsdom
//
// story #3722(Trust·PR2) — 確定 설계(단일 통합 섹션, PO 2026-09-09 09:13Z). 옛 Timeline+Tool
// Audit Trail 두 판을 하나로 합친 새 자리라 옛 타입(ToolCallEntry/ToolAuditEntry)과 무관하게
// 새로 짠다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentRunToolCallsSection } from './agent-run-tool-calls-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
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

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tc-1',
    tool: null,
    method: 'GET',
    path: '/api/v2/stories',
    status_code: 200,
    duration_ms: 128,
    started_at: '2026-09-09T00:00:00Z',
    created_at: '2026-09-09T00:00:00Z',
    input_summary: null,
    error: null,
    attribution_reason: 'header',
    ...overrides,
  };
}

function stubFetch(handler: (url: string) => { ok: boolean; status?: number; json: () => Promise<unknown>; headers?: Record<string, string> }) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => handler(String(input))));
}

function mountSection(runStatus: 'completed' | 'failed' | 'abandoned' | 'running' | 'queued' | 'held' | 'hitl_pending' = 'completed') {
  return act(async () => {
    root.render(wrap(
      <AgentRunToolCallsSection runId="run-1" runStatus={runStatus} locale="ko" displayTimezone="Asia/Seoul" />,
    ));
  });
}

describe('AgentRunToolCallsSection', () => {
  it('story #3722(빈 상태 축③) — 종료된 run·0건은 「도구를 쓰지 않았습니다」', async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ data: [], meta: { totalCount: 0 } }) }));
    await mountSection('completed');
    await flush();
    expect(container.textContent).toContain(koMessages.agentRuns.toolCallsEmptyNone);
    expect(container.textContent).not.toContain(koMessages.agentRuns.toolCallsEmptyPending);
  });

  it('story #3722(빈 상태 축③) — 진행 중 run·0건은 「아직 기록이 없습니다」(다른 사실)', async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ data: [], meta: { totalCount: 0 } }) }));
    await mountSection('running');
    await flush();
    expect(container.textContent).toContain(koMessages.agentRuns.toolCallsEmptyPending);
    expect(container.textContent).not.toContain(koMessages.agentRuns.toolCallsEmptyNone);
  });

  it('⭐story #3722(E절) — 제목 문자열엔 수가 없고 CountBadge에만 있다', async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ data: [row()], meta: { totalCount: 7 } }) }));
    await mountSection();
    await flush();
    const heading = container.querySelector('h2');
    expect(heading?.textContent).not.toMatch(/\(\d+\)/);
    expect(heading?.querySelector('span')?.textContent).toBe('7');
  });

  // story #3722(카디르 QA changes, #4089 리뷰 2026-09-09) — 「attribution_reason 화면
  // 미노출」 계약을 지키는 회귀 단언이 0개였다(뮤테이션: `<span>{row.attribution_reason}</span>`
  // 넣어도 기존 17개 테스트가 그대로 통과). 값 자체를 뮤테이션 검출용 특이 문자열로 —
  // 이 문자열이 화면 어디에도 안 서야 한다(입력 요약·에러 접기 등 어떤 자리로도).
  it('⭐attribution_reason은 화면에 절대 안 그려진다(값을 렌더에 넣으면 이 단언이 RED)', async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => ({ data: [row({ attribution_reason: 'ambiguous_multi_run_same_story' })], meta: { totalCount: 1 } }),
    }));
    await mountSection();
    await flush();
    expect(container.textContent).not.toContain('ambiguous_multi_run_same_story');
  });

  it('⭐페드루 PO 決(09:13Z) — tool 있으면 1차 라벨=tool, method+path는 부제로 демoted', async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => ({ data: [row({ tool: 'sprintable_add_task' })], meta: { totalCount: 1 } }),
    }));
    await mountSection();
    await flush();
    expect(container.textContent).toContain('sprintable_add_task');
    expect(container.textContent).toContain('GET /api/v2/stories'); // 부제로는 여전히 보인다
  });

  // story #3722(페드루 PO 지적, #4089 리뷰 2026-09-09) — 최초 決(09:13Z, "method+path를
  // 1차로 승격")은 다시 보니 코드 값(HTTP 경로)이 제목 자리에 서는 결함이었다(오늘 이벤트
  // 키·stibee와 같은 클래스). 「이름 없는 호출」(모름을 모름이라 쓴다)로 정정 — 경로는
  // tool 유무와 무관하게 항상 부제로만.
  it('⭐tool 없으면 「이름 없는 호출」(고정 문구)이 1차, method+path는 부제로만(제목 자리에 raw 경로 금지)', async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ data: [row({ tool: null })], meta: { totalCount: 1 } }) }));
    await mountSection();
    await flush();
    expect(container.textContent).toContain(koMessages.agentRuns.toolCallsUnnamedCall);
    expect(container.textContent).toContain('GET /api/v2/stories'); // 부제로는 여전히 보인다(D2/D3 관례)
    // 1차 라벨 자리엔 고정 문구만 — raw 경로가 안 선다(경로는 부제 줄에만).
    const primary = container.querySelector('[data-testid="tool-call-primary-tc-1"]');
    expect(primary?.textContent).toBe(koMessages.agentRuns.toolCallsUnnamedCall);
  });

  it('status_code<400은 성공 배지, ≥400은 실패 배지', async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => ({
        data: [row({ id: 'ok-1', status_code: 200 }), row({ id: 'fail-1', status_code: 500 })],
        meta: { totalCount: 2 },
      }),
    }));
    await mountSection();
    await flush();
    expect(container.textContent).toContain(koMessages.agentRuns.toolCallsSuccessBadge);
    expect(container.textContent).toContain(koMessages.agentRuns.toolCallsFailedBadge);
  });

  it('행을 펼치면 input_summary·error가 보이고, 접으면 안 보인다', async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => ({
        data: [row({ input_summary: { title: 'x' }, error: 'boom' })],
        meta: { totalCount: 1 },
      }),
    }));
    await mountSection();
    await flush();
    expect(container.textContent).not.toContain('boom');
    const toggle = container.querySelector('[data-testid="tool-call-toggle-tc-1"]') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(container.textContent).toContain('boom');
    expect(container.textContent).toContain('"title"');
  });

  // story #3722(페드루 PO 사전 스티어, PR2) — `error` raw 노출 금지. 사람이 읽는 한
  // 줄(고정 문구)은 행을 펼치면 항상 보이고, 서버 원문(raw)은 그 안에서도 <details>로
  // 한 번 더 접혀 있다(기본 닫힘) — textContent만으로는 hidden 여부를 못 가르므로
  // <details>.open 프로퍼티로 직접 잰다.
  it('⭐오류는 「이 호출이 실패했습니다」 고정 문구가 항상 먼저 보이고, 원문은 <details> 기본 닫힘 안에 있다', async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => ({ data: [row({ error: 'Traceback (most recent call last): boom' })], meta: { totalCount: 1 } }),
    }));
    await mountSection();
    await flush();
    const toggle = container.querySelector('[data-testid="tool-call-toggle-tc-1"]') as HTMLButtonElement;
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(container.textContent).toContain(koMessages.agentRuns.toolCallsErrorSummary);
    const details = container.querySelector('details');
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
    // jsdom의 textContent는 <details> 닫힘과 무관하게 자식 텍스트를 그대로 반환한다
    // (visual hidden과 DOM 존재는 다른 축) — 그래서 존재 자체가 아니라 .open으로 잰다.
    expect(details?.querySelector('summary')?.textContent).toBe(koMessages.agentRuns.toolCallsErrorToggle);
  });

  it('입력요약·오류가 둘 다 없으면 펼침 컨트롤 자체가 없다(빈 디스클로저 방지)', async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ data: [row()], meta: { totalCount: 1 } }) }));
    await mountSection();
    await flush();
    expect(container.querySelector('[data-testid="tool-call-toggle-tc-1"]')).toBeNull();
  });

  it('⭐더 보기 — cursor는 마지막 행의 created_at, 응답을 이어붙인다', async () => {
    const calls: string[] = [];
    let page = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      page += 1;
      if (page === 1) {
        return { ok: true, json: async () => ({ data: [row({ id: 'p1', created_at: '2026-09-09T00:00:00Z' })], meta: { totalCount: 2 } }) };
      }
      return { ok: true, json: async () => ({ data: [row({ id: 'p2', created_at: '2026-09-08T00:00:00Z' })], meta: { totalCount: 2 } }) };
    }));
    await mountSection();
    await flush();
    const moreBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.agentRuns.loadMore);
    expect(moreBtn).toBeTruthy();
    await act(async () => { moreBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(calls[1]).toContain(`cursor=${encodeURIComponent('2026-09-09T00:00:00Z')}`);
    expect(container.querySelector('[data-testid="tool-call-row-p1"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="tool-call-row-p2"]')).toBeTruthy();
  });

  it('totalCount 未知(meta 없음)이어도 단정하지 않고 CountBadge를 안 그린다', async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ data: [row()] }) }));
    await mountSection();
    await flush();
    const heading = container.querySelector('h2');
    expect(heading?.querySelector('span')).toBeNull();
  });

  it('로딩 실패는 에러 문구를 보이되 섹션 자체는 안 죽는다', async () => {
    stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    await mountSection();
    await flush();
    expect(container.textContent).toContain(koMessages.agentRuns.toolCallsLoadError);
  });
});

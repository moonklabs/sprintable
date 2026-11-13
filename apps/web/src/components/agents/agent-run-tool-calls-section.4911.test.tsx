// @vitest-environment jsdom
//
// story 4911 (UI-R3) — the run detail's tool-call section on ds parts and the layer rule: its own content-layer card (ds SectionHeader with the ds count badge) → each call is the «others» row face
// → an opened call's detail is the well one step in; the success / failed badge is a ds Chip. The same `/agent-runs/{id}/tool-calls` call and the same behaviour as before (the old tests in
// agent-run-tool-calls-section.test.tsx keep guarding the data contract).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { LAYER } from '@/components/ds/layers';
import { AgentRunToolCallsSection, TOOL_CALLS_PANEL_FACE, TOOL_CALL_ROW_FACE, TOOL_CALL_DETAIL_WELL } from './agent-run-tool-calls-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = koMessages.agentRuns;
let container: HTMLDivElement;
let root: Root;

function row(over: Record<string, unknown> = {}) {
  return { id: 'tc-1', tool: 'sprintable_add_task', method: 'POST', path: '/api/v2/tasks', status_code: 200, duration_ms: 420, started_at: '2026-11-12T00:00:00Z', created_at: '2026-11-12T00:00:00Z', input_summary: null, error: null, attribution_reason: 'x', ...over };
}

function stub(rows: unknown[], totalCount: number | null = rows.length) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: rows, meta: totalCount == null ? undefined : { totalCount } }) }) as Response));
}

async function mount(status: 'completed' | 'running' = 'completed') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <AgentRunToolCallsSection runId="run-1" runStatus={status} locale="ko" displayTimezone="Asia/Seoul" />
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
const section = () => q('[data-testid="agent-run-tool-calls"]') as HTMLElement;

describe('도구 호출 구역 — 내용 칸 하나 · 호출 한 줄 = 글 줄 면 (story 4911)', () => {
  it('⭐구역은 내용 칸 층의 카드 하나, 머리글(h2)은 ds SectionHeader + ds 수 배지(수는 배지에만)', async () => {
    stub([row()], 7);
    await mount();
    expect(container.querySelectorAll('[data-testid="agent-run-tool-calls"]')).toHaveLength(1);
    expect(section().className).toContain('bg-ds-surface');
    expect(section().querySelectorAll('h2')).toHaveLength(1);
    expect(section().querySelector('[data-slot="ds-section-header"]')).not.toBeNull();
    expect(section().querySelector('h2')?.textContent).toContain(T.toolCallsTitle);
    expect(section().querySelector('[data-slot="ds-count-badge"]')?.textContent).toBe('7');
    expect(section().querySelector('h2')?.textContent).not.toMatch(/\(\d+\)/);
  });

  it('수를 모르면(meta 없음) 수 배지를 안 그린다', async () => {
    stub([row()], null);
    await mount();
    expect(section().querySelector('[data-slot="ds-count-badge"]')).toBeNull();
  });

  it('⭐한 호출 = 글 줄 면 한 줄(rowOthers), 호출 사이는 박스 테두리 없이 간격만', async () => {
    stub([row({ id: 'a' }), row({ id: 'b' })]);
    await mount();
    for (const id of ['a', 'b']) {
      const r = q(`[data-testid="tool-call-row-${id}"]`) as HTMLElement;
      expect(r.className).toContain('bg-ds-surface-high');
      expect(r.className).not.toContain('border');
    }
  });

  it('⭐성공 · 실패는 글자가 있는 ds 칩 — 성공 = done · 실패 = failed (status_code 400 기준)', async () => {
    stub([row({ id: 'ok', status_code: 200 }), row({ id: 'bad', status_code: 500, error: 'boom' })]);
    await mount();
    const chip = (id: string) => q(`[data-testid="tool-call-row-${id}"] [data-slot="ds-chip"]`);
    expect(chip('ok')?.getAttribute('data-tone')).toBe('done');
    expect(chip('ok')?.textContent).toBe(T.toolCallsSuccessBadge);
    expect(chip('bad')?.getAttribute('data-tone')).toBe('failed');
    expect(chip('bad')?.textContent).toBe(T.toolCallsFailedBadge);
  });

  it('⭐펼친 호출의 안쪽(입력 요약 · 오류)은 우물 면(well) — 줄 면보다 한 단 들어감, 펼치기 전엔 없음', async () => {
    stub([row({ input_summary: { title: 'x' }, error: 'boom', status_code: 500 })]);
    await mount();
    const r = q('[data-testid="tool-call-row-tc-1"]') as HTMLElement;
    expect(r.querySelector('.bg-ds-surface-highest')).toBeNull();
    await act(async () => { (q('[data-testid="tool-call-toggle-tc-1"]') as HTMLButtonElement).click(); });
    const well = r.querySelector('.bg-ds-surface-highest');
    expect(well).not.toBeNull();
    expect(well?.textContent).toContain('boom');
    expect(well?.textContent).toContain('"title"');
    // the fixed «this call failed» line is in the failed ink (the words come with it — the colour never speaks alone)
    expect(well?.querySelector('p.text-ds-failed')?.textContent).toBe(T.toolCallsErrorSummary);
  });

  it('⭐빈 · 오류 얼굴은 ds 글 색(ink-3)이고 카드 안에 서 있다', async () => {
    stub([], 0);
    await mount('completed');
    expect(section().textContent).toContain(T.toolCallsEmptyNone);
    expect(section().querySelector('p')?.className).toContain('text-ds-ink-3');
  });
});

describe('도구 호출 구역은 화면 층 규칙의 토큰을 쓴다 · 옛 부품 0 (story 4911)', () => {
  const src = readFileSync(join(__dirname, 'agent-run-tool-calls-section.tsx'), 'utf8');

  it('⭐카드 = 내용 칸 · 호출 줄 = 글 줄 · 안쪽 = 우물 — 이름을 한 번 짓고 마크업이 그 이름을 쓴다', () => {
    expect(TOOL_CALLS_PANEL_FACE).toBe(LAYER.panel);
    expect(TOOL_CALL_ROW_FACE).toBe(LAYER.rowOthers);
    expect(TOOL_CALL_DETAIL_WELL).toBe(LAYER.well);
    expect(src).toContain('export const TOOL_CALLS_PANEL_FACE = LAYER.panel;');
    expect(src).toContain('export const TOOL_CALL_ROW_FACE = LAYER.rowOthers;');
    expect(src).toContain('export const TOOL_CALL_DETAIL_WELL = LAYER.well;');
    for (const use of ['${TOOL_CALLS_PANEL_FACE}', '${TOOL_CALL_ROW_FACE}', '${TOOL_CALL_DETAIL_WELL}']) expect(src, use).toContain(use);
  });

  it('⭐옛 부품 0(SectionCard · ui Badge · ui CountBadge · overlay-fill · bg-muted · text-muted-foreground · divide-border) — ds 부품(SectionHeader · Chip · Button · CountBadge)', () => {
    for (const legacy of ['SectionCard', "@/components/ui/badge", "@/components/ui/count-badge", 'overlay-fill', 'overlay-line', 'bg-muted', 'text-muted-foreground', 'divide-border', 'text-destructive', 'text-foreground']) expect(src, legacy).not.toContain(legacy);
    for (const part of ["@/components/ds/section-header", "@/components/ds/chip", "@/components/ds/button", "@/components/ds/count-badge"]) expect(src, part).toContain(part);
  });
});

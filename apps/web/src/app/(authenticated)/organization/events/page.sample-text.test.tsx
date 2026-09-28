// @vitest-environment jsdom
//
// story #4257(까디르 codex 01a0d2fb P2 · PO 10:43Z) — 실제 useSampleText() 훅을 거친 예시값을 «만들기 미리보기»와 «테스트 발행 payload»
// 두 표면에서 ko · en 둘 다 잠근다(주입 SAMPLE 없이). 훅의 summary · source · member 매핑이나 두 표면의 배선이 일반 «예시 {name}»로 돌아가면 RED.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';
import enMessages from '../../../../../messages/en.json';
import { FORM_DEFAULT_STAGE_TEXT } from '@/components/organization/event-definer-logic';
import { SEED_STAGE_TEXTS } from '@/lib/platform-preset-copy';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // currentTeamMemberId 없음 — 테스트 발행이 멤버 id를 실제 id로 덮기 **전** 값(훅의 member 문구)이 그대로 payload에 남는다.
  useDashboardContextMock.mockReturnValue({
    orgId: 'org-1',
    orgMemberships: [{ orgId: 'org-1', orgName: 'Acme', orgSlug: 'acme', role: 'admin' }],
    projectMemberships: [],
  });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function setInputValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const dialog = () => document.body.querySelector('[data-slot="dialog-content"]') as HTMLElement;
const button = (scope: ParentNode, text: string, exact = false) =>
  [...scope.querySelectorAll('button')].find((b) => (exact ? b.textContent === text : b.textContent?.includes(text))) as HTMLButtonElement;

describe.each([
  ['ko', koMessages],
  ['en', enMessages],
])('정의 만들기 — 미리보기 · 테스트 발행 예시값이 실제 훅을 거친 로케일 문구(%s)', (locale, messages) => {
  const m = messages.organization;

  it('⭐summary · source · 멤버 id 세 키가 자기 문구 — 일반 «예시 {name}»이 아니다', async () => {
    const calls: { url: string; body?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, body: init?.body });
      if (url === '/api/events/definitions' && init?.method === 'POST') {
        return { ok: true, json: async () => ({ ...JSON.parse(init.body ?? '{}'), id: 'new-id' }) };
      }
      if (url === '/api/events/definitions' || url.startsWith('/api/events/definitions/publish-history')) return { ok: true, json: async () => [] };
      return { ok: true, json: async () => ({}) };
    }));
    const { default: OrganizationEventsPage } = await import('./page');
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
          <OrganizationEventsPage />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const workflowTab = [...document.body.querySelectorAll('[role="tab"], button')].find((el) => el.textContent?.startsWith(m.recipeGalleryTabWorkflow)) as HTMLElement | undefined;
    if (workflowTab) await act(async () => { workflowTab.click(); });
    await act(async () => { button(container, m.eventCreateCta, true).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // story #4257(PO 11:27Z) — 머리말 · 이벤트 이름이 둘 다 비면 미리보기 머리말은 로케일 자리 표시(저장값엔 남지 않는다).
    expect(dialog().textContent).toContain(m.definerUnnamedPreview);

    await act(async () => {
      setInputValue(document.body.querySelector('#event-name') as HTMLInputElement, 'sample');
      setInputValue(dialog().querySelector('#definer-key') as HTMLInputElement, 'sample_text');
    });
    await act(async () => { button(dialog(), m.definerAddStage).click(); });
    await act(async () => { setInputValue(dialog().querySelector(`input[placeholder="${m.definerStageNamePlaceholder}"]`) as HTMLInputElement, 'a'); });
    await act(async () => { button(dialog(), m.definerAddField).click(); });
    await act(async () => { button(dialog(), m.definerAddField).click(); });
    const fieldInputs = dialog().querySelectorAll('tbody input') as NodeListOf<HTMLInputElement>;
    await act(async () => { setInputValue(fieldInputs[0], 'summary'); setInputValue(fieldInputs[1], 'source'); });

    // ① 만들기 미리보기(EventBlockCard · 필드 블록)
    const preview = dialog().textContent ?? '';
    // story #4257 — 머리말이 비면 미리보기도 저장과 같은 이벤트 이름 · 기본 단계 문장은 보는 사람의 언어(씨앗 문장 → recipePreset.stageMovedBody).
    expect(preview).toContain('sample');
    expect(preview).not.toContain(m.definerUnnamedPreview);
    expect(preview).toContain(messages.recipePreset.stageMovedBody.replace('{stage}', 'a').replace(/\*\*/g, ''));
    expect(preview).not.toContain('넘어갔습니다');
    expect(preview).toContain(m.definerSampleSummary);
    expect(preview).toContain(m.definerSampleSource);
    // en은 «Sample summary» · «Sample source»가 일반 «Sample {name}»과 글자가 같아 부정 단언이 성립하지 않는다 — 두 매핑은 ko 회차가 잠근다
    // (member는 두 로케일 다 일반 문구와 달라 양쪽이 잠근다).
    for (const name of ['summary', 'source'] as const) {
      const generic = m.definerSampleValue.replace('{name}', name);
      const specific = name === 'summary' ? m.definerSampleSummary : m.definerSampleSource;
      if (generic !== specific) expect(preview).not.toContain(generic);
    }

    // ② 테스트 발행 payload(저장 뒤)
    await act(async () => { button(dialog(), m.eventCreateSubmit, true).click(); });
    // 저장 본문 — 머리말 = 이벤트 이름(자리 표시 저장 0) · 단계 문장 = 씨앗 문장 그대로(표시할 때 로케일).
    const saved = JSON.parse(calls.find((c) => c.url === '/api/events/definitions' && c.body)!.body!) as { block_template: { blocks: { type: string; text?: string }[] } };
    expect(saved.block_template.blocks[0]).toEqual({ type: 'header', text: 'sample' });
    // 폼이 새로 저장하는 값은 정식 씨앗 문장(옛 기본 문장 '단계 … 넘어갔습니다.'가 아니라) — 씨앗 목록의 payload.stage 문장과 글자까지 같다.
    expect(saved.block_template.blocks[1]).toEqual({ type: 'text', text: '**{{payload.stage}}** 로 넘어갔습니다' });
    expect(SEED_STAGE_TEXTS).toContain(FORM_DEFAULT_STAGE_TEXT);
    await act(async () => { button(dialog(), m.definerTestPublishCta, true).click(); });
    const publish = calls.find((c) => c.url === '/api/events/publish');
    const payload = JSON.parse(publish!.body!).payload as Record<string, unknown>;
    expect(payload.summary).toBe(m.definerSampleSummary);
    expect(payload.source).toBe(m.definerSampleSource);
    expect(payload.assignee_member_id).toBe(m.definerSampleMemberId);
    expect(payload.assignee_member_id).not.toBe(m.definerSampleValue.replace('{name}', 'assignee_member_id'));
  });
});

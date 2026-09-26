// @vitest-environment jsdom
//
// [SID:4300 · PO 06:37Z · 유나 짚음] 스탠드업 피드백 작성자 이름 — 예전엔 이름 빔 · 명단에 없음 둘 다 «알 수 없음»(standup.unknown)이었다.
// #4284 규칙: 명단에 있는데 이름 빔 = «이름 없는 구성원», 명단에 없음 = «알 수 없는 구성원»(명단이 거른 비활성 · 다른 프로젝트 사람은 조직
// 원천으로 보충해 이름), 같은 폴백 글자가 서로 다른 사람 둘 이상에 서면 그 폴백에만 id 앞 8자 꼬리.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { StandupFeedbackDialog } from './standup-feedback-dialog';
import { ORG_NAMES_URL, resetOrgMembersCacheForTests } from '@/hooks/use-member-name-fallback';
import type { StandupFeedbackSummary } from './standup-types';

const dashCtx = vi.hoisted(() => ({ value: {} as { orgId?: string } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => dashCtx.value }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  dashCtx.value = {};
  resetOrgMembersCacheForTests();
});

function fb(id: string, by: string): StandupFeedbackSummary {
  return { id, standup_entry_id: 'e1', feedback_by_id: by, review_type: 'comment', feedback_text: `본문-${id}`, created_at: '2026-09-25T00:00:00Z', updated_at: '2026-09-25T00:00:00Z' };
}

async function render(feedback: StandupFeedbackSummary[], memberNameById: Record<string, string>) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <StandupFeedbackDialog
          open
          onOpenChange={() => {}}
          member={{ id: 'm-anna', name: '안나', type: 'human' }}
          entry={{ id: 'e1', author_id: 'm-anna', date: '2026-09-25', done: '', plan: '', blockers: null, plan_story_ids: [] }}
          feedback={feedback}
          stories={[]}
          memberNameById={memberNameById}
          currentMemberId="me"
          onCreateFeedback={() => {}}
          onUpdateFeedback={() => {}}
          onDeleteFeedback={() => {}}
        />
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const bodyText = () => document.body.textContent ?? '';

describe('StandupFeedbackDialog — 피드백 작성자 이름([SID:4300])', () => {
  it('이름 빔 → «이름 없는 구성원» · 명단에 없는 한 사람 → «알 수 없는 구성원»(꼬리 없음) · «알 수 없음» 0', async () => {
    await render([fb('f1', 'm-anna'), fb('f2', 'm-noname'), fb('f3', 'gone-aaaa1111')], { 'm-anna': '안나', 'm-noname': null as unknown as string });
    const text = bodyText();
    expect(text).toContain('안나');
    expect(text).toContain(koMessages.common.memberUnnamed);
    expect(text).toContain(koMessages.common.memberUnknown);
    expect(text).not.toContain(`${koMessages.common.memberUnknown} ·`);
    expect(text).not.toContain(koMessages.standup.unknown);
  });

  it('명단에 없는 서로 다른 두 사람 → 두 폴백에만 id 앞 8자 꼬리(겹칠 때만)', async () => {
    await render([fb('f1', 'gone-aaaa1111'), fb('f2', 'gone-bbbb2222'), fb('f3', 'gone-aaaa1111')], { 'm-anna': '안나' });
    const text = bodyText();
    expect(text).toContain(`${koMessages.common.memberUnknown} · gone-aaa`);
    expect(text).toContain(`${koMessages.common.memberUnknown} · gone-bbb`);
  });

  it('명단(활성만)에 없는 비활성 에이전트 → 조직 원천으로 이름', async () => {
    dashCtx.value = { orgId: 'org-1' };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url === ORG_NAMES_URL
        ? { ok: true, json: async () => ({ data: [{ id: 'a-inactive', name: '쉬는봇', type: 'agent' }] }) }
        : { ok: false, json: async () => null }
    )));
    await render([fb('f1', 'a-inactive')], { 'm-anna': '안나' });
    expect(bodyText()).toContain('쉬는봇');
    expect(bodyText()).not.toContain(koMessages.common.memberUnknown);
  });
});

// [SID:4300 · PO 16:27Z · story #4311 뒤] 꼬리 규칙 «보이는 글자가 같으면»(4678) × 받는 동안 빈 글자 — 빈 글자 행은 규칙 밖(« · id»만 보이는 줄 0),
// 받은 뒤 동명이인 두 작성자는 id 앞 8자로 갈린다.
describe('StandupFeedbackDialog — 4311 꼬리 규칙 × 받는 동안 빈 글자([SID:4300])', () => {
  it('조직 원천 받는 동안 « · » 꼬리 0 · «알 수 없음» 0 → 받은 뒤 동명이인 «송윤재» 둘 = id 앞 8자', async () => {
    dashCtx.value = { orgId: 'org-1' };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === ORG_NAMES_URL) { await gate; return { ok: true, json: async () => ({ data: [{ id: 'dup-aaaa1', name: '송윤재', type: 'human' }, { id: 'dup-bbbb2', name: '송윤재', type: 'human' }] }) }; }
      return { ok: false, json: async () => null };
    }));
    await render([fb('f1', 'dup-aaaa1'), fb('f2', 'dup-bbbb2')], { 'm-anna': '안나' });
    const text0 = document.body.textContent ?? '';
    expect(text0).not.toMatch(/ · dup-/);
    expect(text0).not.toContain(koMessages.common.memberUnknown);
    await act(async () => { release(); });
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const text = document.body.textContent ?? '';
    expect(text).toContain('송윤재 · dup-aaaa');
    expect(text).toContain('송윤재 · dup-bbbb');
  });
});

// @vitest-environment jsdom
//
// story 4921 — the direction instruction's card (the 0475 template) draws the target member's NAME and the work item's TITLE, its fixed words come from the viewer's language,
// and a message published before this story (no `refs.target`) leaves the «지시 대상자» line out instead of claiming «unknown». The real card, the real template, the real ko/en copy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { EventBlockCard } from './event-block-card';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

// exactly what migration 0475 writes
const STEER_TEMPLATE = {
  blocks: [
    { type: 'header' as const, text: '{{t.steerHeader}}' },
    { type: 'text' as const, text: '{{payload.instruction}}' },
    { type: 'fields' as const, fields: [
      { label: '{{t.targetLabel}}', value: '{{label.work_item_target}}', optional: true },
      { label: '{{t.steerTargetLabel}}', value: '{{label.target_name}}', optional: true },
    ] },
  ],
};
const TARGET = '97470487-345a-4e85-9c45-cdf901737adb';
const STORY = '946300bd-434c-45d6-901d-c0d1af8603e7';

async function draw(locale: 'ko' | 'en', props: { payload: Record<string, unknown>; refs?: Record<string, unknown> }) {
  const messages = locale === 'ko' ? koMessages : enMessages;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
        <EventBlockCard template={STEER_TEMPLATE} payload={props.payload} refs={props.refs as never} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human', role: 'admin', orgId: 'org-1' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [], error: null, meta: null }) })));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

describe('EventBlockCard — 방향 지시 카드(story 4921)', () => {
  it('⭐일감 있는 지시: «대상» = 일감 제목, «지시 대상자» = 구성원 이름 — uuid가 화면에 없다', async () => {
    await draw('ko', {
      payload: { work_item_type: 'story', work_item_id: STORY, target_member_id: TARGET, instruction: '먼저 봐 주세요' },
      refs: { work_item: { found: true, token: `[시험 일감](entity:story:${STORY})` }, target: { found: true, name: '미르코' } },
    });
    const text = container.textContent ?? '';
    expect(text).toContain('방향 전환');
    expect(text).toContain('먼저 봐 주세요');
    expect(text).toContain('대상'); expect(text).toContain('시험 일감');
    expect(text).toContain('지시 대상자'); expect(text).toContain('미르코');
    expect(text).not.toContain(TARGET); expect(text).not.toContain(STORY);
  });

  it('⭐일감 없는 지시: «지시 대상자»만 — «대상» 줄이 없다(0474) · 구성원 이름은 그대로', async () => {
    await draw('ko', { payload: { target_member_id: TARGET, instruction: '이제 A로 가자' }, refs: { target: { found: true, name: '미르코' } } });
    const text = container.textContent ?? '';
    expect(text).toContain('지시 대상자'); expect(text).toContain('미르코');
    expect(text).not.toMatch(/대상(?!자)/); // «대상» alone is not on the card (only «지시 대상자»)
    expect(text).not.toContain(TARGET);
  });

  it('⭐구성원이 지금 없는 새 메시지(refs.target = found:false): «알 수 없는 구성원» — uuid가 아니다', async () => {
    await draw('ko', { payload: { target_member_id: TARGET, instruction: '지시' }, refs: { target: { found: false } } });
    const text = container.textContent ?? '';
    expect(text).toContain(koMessages.eventCard.memberMissing);
    expect(text).not.toContain(TARGET);
  });

  it('⭐옛 메시지(refs.target 자체가 없음): «지시 대상자» 줄을 빼고 «알 수 없는»이라 말하지 않는다 · 지시 글은 그대로 · uuid 없음', async () => {
    await draw('ko', { payload: { target_member_id: TARGET, instruction: '옛 지시 글' }, refs: {} });
    const text = container.textContent ?? '';
    expect(text).toContain('옛 지시 글'); expect(text).toContain('방향 전환');
    expect(text).not.toContain('지시 대상자');
    expect(text).not.toContain(koMessages.eventCard.memberMissing);
    expect(text).not.toContain(TARGET);
  });

  it('⭐영어 사용자: 머리 · 라벨이 영어다(옛 카드는 «방향 전환 / 대상 / 지시 대상자» 한국어가 구워져 나왔다)', async () => {
    await draw('en', {
      payload: { work_item_type: 'story', work_item_id: STORY, target_member_id: TARGET, instruction: 'Look at this first' },
      refs: { work_item: { found: true, token: `[Test story](entity:story:${STORY})` }, target: { found: true, name: 'Mirko' } },
    });
    const text = container.textContent ?? '';
    expect(text).toContain(enMessages.eventCard.steerHeader); expect(text).toContain(enMessages.eventCard.steerTargetLabel);
    expect(text).toContain('Mirko'); expect(text).toContain('Test story');
    expect(text).not.toMatch(/[가-힣]/);
  });

  it('ko / en 낱말 키가 짝이다', () => {
    for (const k of ['steerHeader', 'steerTargetLabel', 'memberMissing', 'genericEventHeader'] as const) {
      expect(koMessages.eventCard[k]).toBeTruthy(); expect(enMessages.eventCard[k]).toBeTruthy();
    }
  });
});

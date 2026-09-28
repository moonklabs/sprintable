// @vitest-environment jsdom
//
// [SID:4300 · 유나 실측 캡처] 스탠드업 사람 카드 — 이름이 null이면 이름 칸이 빈칸이고 «사람» 칩만 보였다. 명단의 행이라 «이름 빔»뿐이다:
// 사람 · 에이전트 모두 «이름 없는 구성원»(유나 판정 06:47Z — 타입은 옆 칩이 가름 · «이름 없는 에이전트»는 대화 미연결 배너 전용). 이름이 있으면 그대로.
// story #4311(4678) 뒤로 카드는 라벨을 스스로 만들지 않고 부모(standup-client)가 memberRowLabels로 만든 행 라벨(rowLabel)을 그린다 —
// 사람 목록 · 에이전트 목록을 따로 매긴다(부모와 같은 모양). 그래서 이 테스트도 부모처럼 라벨을 매겨 넘기고 카드가 그대로 그리는지 본다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { StandupBoardCard } from './standup-board-card';
import { memberRowLabels } from '@/lib/member-display';

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
});

type Member = { id: string; name: string | null; type: 'human' | 'agent' };
const tc = (key: string) => (koMessages.common as Record<string, string>)[key] ?? key;

// 부모(standup-client)와 같은 모양 — 사람 · 에이전트 목록을 따로 memberRowLabels로 매긴다.
function rowLabelsLikeParent(members: Member[]): Map<string, string> {
  return new Map([
    ...memberRowLabels(members.filter((m) => m.type === 'human'), tc, () => ''),
    ...memberRowLabels(members.filter((m) => m.type === 'agent'), tc, () => ''),
  ]);
}

async function render(member: Member, rowLabel: string) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <StandupBoardCard member={member as { id: string; name: string; type: 'human' | 'agent' }} rowLabel={rowLabel} feedback={[]} isCurrentUser={false} onOpenFeedback={() => {}} />
      </NextIntlClientProvider>,
    );
  });
}

describe('StandupBoardCard — 이름 칸([SID:4300] · 행 라벨은 부모 memberRowLabels · story #4311)', () => {
  const members: Member[] = [
    { id: 'm1', name: null, type: 'human' },
    { id: 'a1', name: null, type: 'agent' },
    { id: 'm2', name: '안나', type: 'human' },
  ];
  const labels = rowLabelsLikeParent(members);

  it.each([
    ['사람 · 이름 null', members[0]!, koMessages.common.memberUnnamed],
    ['에이전트 · 이름 null(«이름 없는 에이전트» 아님)', members[1]!, koMessages.common.memberUnnamed],
    ['이름 있음', members[2]!, '안나'],
  ])('%s → «%s»', async (_n, member, expected) => {
    await render(member, labels.get(member.id)!);
    const nameSpan = container.querySelector('span.text-sm.font-semibold');
    expect(nameSpan?.textContent).toBe(expected);
    expect(nameSpan?.textContent).not.toBe('');
  });

  it('같은 목록에 이름 없는 사람이 둘이면 카드 이름 칸에 «· ID 앞 8자» 꼬리(4311 규칙 그대로 그림)', async () => {
    const two: Member[] = [{ id: 'aaaaaaaa-1', name: null, type: 'human' }, { id: 'bbbbbbbb-2', name: null, type: 'human' }];
    const l = rowLabelsLikeParent(two);
    await render(two[0]!, l.get(two[0]!.id)!);
    expect(container.querySelector('span.text-sm.font-semibold')?.textContent).toBe(`${koMessages.common.memberUnnamed} · aaaaaaaa`);
  });
});

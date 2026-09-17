// @vitest-environment jsdom
//
// story #3972 CI 후속(페드루 PO) — 행 버튼에 aria-label을 붙이면 스크린리더가
// 자식 텍스트(역할 태그·마지막 메시지 미리보기)를 더 안 읽는 회귀가 났다 —
// aria-describedby로 되잇는지 접근성 이름/설명 축으로 고정한다(이 레포는
// @testing-library/jest-dom 없이 raw DOM assertion 관례라, id 참조를 직접
// 따라가 accessible name/description을 재현한다 — 새 라이브러리 0).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatV3ThreadRail, type ChatV3Thread } from './chat-v3-thread-rail';

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

function accessibleDescription(button: Element): string {
  const ids = (button.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
  return ids
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

const AGENT_THREAD: ChatV3Thread = {
  id: 'conv-agent',
  participants: [{ member_id: 'me-1', name: '나', type: 'human' }, { member_id: 'agent-1', name: '담롱 온찬', type: 'agent' }],
  latest_message: { content: '초안을 마쳤어요.', created_at: '2026-09-16T06:41:00Z' },
  unread_count: 0,
};
const HUMAN_THREAD: ChatV3Thread = {
  id: 'conv-human',
  participants: [{ member_id: 'me-1', name: '나', type: 'human' }, { member_id: 'human-1', name: '유나', type: 'human' }],
  latest_message: { content: '리뷰 부탁해요', created_at: '2026-09-16T06:42:00Z' },
  unread_count: 0,
};

describe('ChatV3ThreadRail — 접근 이름·설명(story #3972 CI 후속)', () => {
  it('⭐에이전트 행 — 접근 이름=「{label}, 목록 {n}번째」, 접근 설명에 역할 태그+미리보기가 둘 다 있다', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatV3ThreadRail threads={[AGENT_THREAD, HUMAN_THREAD]} meId="me-1" selectedId={null} onSelect={() => {}} />,
      ));
    });
    const rows = container.querySelectorAll('[data-testid="chat-v3-thread-row"]');
    const agentRow = rows[0];
    expect(agentRow.getAttribute('aria-label')).toBe('담롱 온찬, 목록 1번째');
    const desc = accessibleDescription(agentRow);
    expect(desc).toContain('에이전트');
    expect(desc).toContain('초안을 마쳤어요.');
  });

  it('⭐사람 행 — 접근 이름에 순번이 반영되고, 접근 설명엔 역할 태그가 없고 미리보기만 있다(사람은 role 태그 자체가 없음)', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatV3ThreadRail threads={[AGENT_THREAD, HUMAN_THREAD]} meId="me-1" selectedId={null} onSelect={() => {}} />,
      ));
    });
    const rows = container.querySelectorAll('[data-testid="chat-v3-thread-row"]');
    const humanRow = rows[1];
    expect(humanRow.getAttribute('aria-label')).toBe('유나, 목록 2번째');
    const desc = accessibleDescription(humanRow);
    expect(desc).not.toContain('에이전트');
    expect(desc).toContain('리뷰 부탁해요');
  });
});

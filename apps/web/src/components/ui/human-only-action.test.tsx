// @vitest-environment jsdom
//
// story #2104(AC6) — #2091(게이트 승인)·#2103(HITL 인라인)에서 반복된 결함(BE가 human-only로
// 403 거부하는 파괴적/결정 조작에 FE가 버튼을 무조건 열어 "내가 할 수 있다"고 믿게 만든 것)을
// 막는 공용 wrapper. HOC(디디군이 오늘 lint에 막힘)가 아니라 children을 받는 평범한
// 컴포넌트라는 것 자체가 이 테스트의 전제 — 렌더 시점 게이팅만 검증한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HumanOnlyAction } from './human-only-action';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

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

async function render(currentMemberType: 'human' | 'agent' | undefined) {
  useDashboardContextMock.mockReturnValue({ currentMemberType });
  await act(async () => {
    root.render(
      <HumanOnlyAction fallback={<p>권한없음</p>}>
        <button type="button">삭제</button>
      </HumanOnlyAction>,
    );
  });
}

describe('HumanOnlyAction (story #2104)', () => {
  it('human이면 children(액션 버튼)이 렌더된다 — 정당한 사용자까지 잠그면 더 큰 사고인', async () => {
    await render('human');
    expect(container.querySelector('button')?.textContent).toBe('삭제');
    expect(container.textContent).not.toContain('권한없음');
  });

  it('agent면 children 대신 fallback이 렌더된다', async () => {
    await render('agent');
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('권한없음');
  });

  it('currentMemberType이 없으면(구버전/누락) fallback으로 fail-closed된다', async () => {
    await render(undefined);
    expect(container.querySelector('button')).toBeNull();
  });

  it('fallback을 안 넘기면 아무것도 안 그린다(기본값)', async () => {
    useDashboardContextMock.mockReturnValue({ currentMemberType: 'agent' });
    await act(async () => {
      root.render(<HumanOnlyAction><button type="button">삭제</button></HumanOnlyAction>);
    });
    expect(container.textContent).toBe('');
  });
});

// @vitest-environment jsdom
//
// story #2013 리뷰 fix B — 핵심 경로 회귀가드 2종(codex REQUEST_CHANGES 무테스트 지적 해소):
// (1) 구조화 에러(403 HUMAN_CONFIRM_REQUIRED·422 INVALID_EPIC_TRANSITION) 응답 시 토스트가 뜨고
// code+message가 둘 다 verbatim으로 화면에 남는지, (2) 200이지만 status 불변(enforcing gate 생성)
// 응답 시 낙관적 반영 없이 "승인 대기" 배지만 뜨고 onTransitioned가 호출되지 않는지.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { EpicStatusTransition } from './epic-status-transition';
import koMessages from '../../../messages/ko.json';

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

async function mount(onTransitioned: (s: string) => void) {
  await act(async () => {
    root.render(wrap(<EpicStatusTransition epicId="epic-1" status="active" onTransitioned={onTransitioned} />));
  });
}

// active → done은 GATED("active>done") 대상이자 VALID_NEXT 상 유효 전이 — 드롭다운을 열고
// "Done" 항목을 클릭해 실제 POST /api/goals/:id/transition 왕복 경로(transition() 핸들러)를 태운다.
async function clickTransitionToDone() {
  const trigger = [...document.body.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '상태 변경')!;
  expect(trigger).not.toBeUndefined();
  await act(async () => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent?.includes('Done'))!;
  expect(item).not.toBeUndefined();
  await act(async () => {
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
}

function stubFetchOnce(response: { ok: boolean; status: number; json: () => Promise<unknown> }) {
  vi.stubGlobal('fetch', vi.fn(async () => response));
}

describe('EpicStatusTransition — 구조화 에러 표면화(story #2013 리뷰 FIX A)', () => {
  it('403 HUMAN_CONFIRM_REQUIRED: 토스트가 뜨고 code+message가 둘 다 화면에 그대로 남는다', async () => {
    stubFetchOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: 'HUMAN_CONFIRM_REQUIRED', message: '이 전이는 사람의 확인이 필요합니다' } }),
    });
    const onTransitioned = vi.fn();
    await mount(onTransitioned);
    await clickTransitionToDone();

    expect(container.textContent).toContain('상태 변경 실패'); // transitionFailedTitle
    expect(container.textContent).toContain('HUMAN_CONFIRM_REQUIRED'); // 코드 verbatim
    expect(container.textContent).toContain('이 전이는 사람의 확인이 필요합니다'); // 메시지 verbatim
    expect(onTransitioned).not.toHaveBeenCalled();
  });

  it('422 INVALID_EPIC_TRANSITION: 토스트가 뜨고 code+message가 둘 다 화면에 그대로 남는다', async () => {
    stubFetchOnce({
      ok: false,
      status: 422,
      json: async () => ({ error: { code: 'INVALID_EPIC_TRANSITION', message: '이 상태로는 전이할 수 없습니다' } }),
    });
    const onTransitioned = vi.fn();
    await mount(onTransitioned);
    await clickTransitionToDone();

    expect(container.textContent).toContain('상태 변경 실패');
    expect(container.textContent).toContain('INVALID_EPIC_TRANSITION');
    expect(container.textContent).toContain('이 상태로는 전이할 수 없습니다');
    expect(onTransitioned).not.toHaveBeenCalled();
  });
});

describe('EpicStatusTransition — gate 생성·승인 대기(story #2013 PO note② — 낙관적 반영 금지)', () => {
  it('200이지만 반환 status가 요청과 다르면(gate 생성) "승인 대기"만 뜨고 onTransitioned는 호출되지 않는다', async () => {
    // active → done 요청했지만 enforcing gate가 생성돼 status는 active로 유지된 응답.
    stubFetchOnce({ ok: true, status: 200, json: async () => ({ data: { status: 'active' } }) });
    const onTransitioned = vi.fn();
    await mount(onTransitioned);
    await clickTransitionToDone();

    expect(container.textContent).toContain('승인 대기'); // transitionPending
    expect(onTransitioned).not.toHaveBeenCalled(); // 낙관적 반영 X
    expect(container.textContent).not.toContain('상태 변경 실패'); // 에러 토스트 오탐 0
  });
});

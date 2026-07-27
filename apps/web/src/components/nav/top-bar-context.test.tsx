// @vitest-environment jsdom
//
// 근본 재구현(2076 회귀 후속, 유나양 규격) — 기본 숨김·표시할 루트 화면만 TopBarSlot에
// showContextChip을 선언해 켠다는 것을 회귀가드로 고정한다. 원래 "숨길 화면을 명시
// (hideContextChip)" 방식은 fail-open이었다 — docs·mockups·retro가 뒤로가기 아이콘 부재로
// grep 기반 탐색에서 3차례 누락되며(2026-07-21) 실측으로 구조적 약점이 증명됐다. "표시할
// 것만 명시·기본 숨김"이면 새 상세 화면이 생겨도 구조적으로 안 샌다.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TopBarProvider, useTopBar } from './top-bar-context';
import { TopBarSlot } from './top-bar-slot';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Probe() {
  const { showContextChip } = useTopBar();
  return <span data-testid="probe">{String(showContextChip)}</span>;
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

describe('TopBarSlot showContextChip — allowlist 재구현(2076 회귀 후속)', () => {
  it('showContextChip을 안 주면(기본) false — 새 화면은 기본적으로 칩이 안 뜬다(fail-closed)', async () => {
    await act(async () => {
      root.render(
        <TopBarProvider>
          <TopBarSlot title={<span>제목</span>} />
          <Probe />
        </TopBarProvider>,
      );
    });
    expect(container.querySelector('[data-testid="probe"]')?.textContent).toBe('false');
  });

  it('showContextChip을 주면 true로 전파된다 — 루트 화면이 명시적으로 칩을 켠다', async () => {
    await act(async () => {
      root.render(
        <TopBarProvider>
          <TopBarSlot title={<span>보드</span>} showContextChip />
          <Probe />
        </TopBarProvider>,
      );
    });
    expect(container.querySelector('[data-testid="probe"]')?.textContent).toBe('true');
  });

  it('루트→상세로 props가 바뀌면 showContextChip도 그에 맞춰 갱신된다', async () => {
    function Wrapper({ isRoot }: { isRoot: boolean }) {
      return (
        <TopBarProvider>
          {isRoot
            ? <TopBarSlot title={<span>목록</span>} showContextChip />
            : <TopBarSlot title={<span>상세</span>} />}
          <Probe />
        </TopBarProvider>
      );
    }
    await act(async () => { root.render(<Wrapper isRoot />); });
    expect(container.querySelector('[data-testid="probe"]')?.textContent).toBe('true');

    await act(async () => { root.render(<Wrapper isRoot={false} />); });
    expect(container.querySelector('[data-testid="probe"]')?.textContent).toBe('false');
  });

  it('TopBarSlot이 언마운트되면(clearSlot) showContextChip도 false로 초기화된다', async () => {
    function Wrapper({ mounted }: { mounted: boolean }) {
      return (
        <TopBarProvider>
          {mounted && <TopBarSlot title={<span>보드</span>} showContextChip />}
          <Probe />
        </TopBarProvider>
      );
    }
    await act(async () => { root.render(<Wrapper mounted />); });
    expect(container.querySelector('[data-testid="probe"]')?.textContent).toBe('true');

    await act(async () => { root.render(<Wrapper mounted={false} />); });
    expect(container.querySelector('[data-testid="probe"]')?.textContent).toBe('false');
  });
});

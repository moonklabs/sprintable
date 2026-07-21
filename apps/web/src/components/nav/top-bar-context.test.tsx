// @vitest-environment jsdom
//
// 긴급 fix(2076 회귀) — 2뎁스+ 상세 화면(자체 뒤로가기 보유)이 TopBarSlot에 hideContextChip을
// 선언하면 TopBar가 실제로 컨텍스트 칩을 뺀다는 것을 회귀가드로 고정한다. RED였던 증상:
// 채팅 상세에서 칩+뒤로가기+제목+액션+아이콘 클러스터가 <1024에서 공간 부족으로 뭉개짐.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TopBarProvider, useTopBar } from './top-bar-context';
import { TopBarSlot } from './top-bar-slot';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Probe() {
  const { hideContextChip } = useTopBar();
  return <span data-testid="probe">{String(hideContextChip)}</span>;
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

describe('TopBarSlot hideContextChip — 2076 긴급 fix 회귀가드', () => {
  it('hideContextChip을 안 주면(기본) false — 기존 화면은 칩이 그대로 보인다', async () => {
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

  it('hideContextChip을 주면 true로 전파된다 — 상세 화면이 칩을 뺀다', async () => {
    await act(async () => {
      root.render(
        <TopBarProvider>
          <TopBarSlot title={<span>채팅 상세</span>} hideContextChip />
          <Probe />
        </TopBarProvider>,
      );
    });
    expect(container.querySelector('[data-testid="probe"]')?.textContent).toBe('true');
  });

  it('상세→목록으로 props가 바뀌면 hideContextChip도 그에 맞춰 갱신된다', async () => {
    function Wrapper({ showDetail }: { showDetail: boolean }) {
      return (
        <TopBarProvider>
          {showDetail
            ? <TopBarSlot title={<span>상세</span>} hideContextChip />
            : <TopBarSlot title={<span>목록</span>} />}
          <Probe />
        </TopBarProvider>
      );
    }
    await act(async () => { root.render(<Wrapper showDetail />); });
    expect(container.querySelector('[data-testid="probe"]')?.textContent).toBe('true');

    await act(async () => { root.render(<Wrapper showDetail={false} />); });
    expect(container.querySelector('[data-testid="probe"]')?.textContent).toBe('false');
  });

  it('TopBarSlot이 언마운트되면(clearSlot) hideContextChip도 false로 초기화된다', async () => {
    function Wrapper({ mounted }: { mounted: boolean }) {
      return (
        <TopBarProvider>
          {mounted && <TopBarSlot title={<span>상세</span>} hideContextChip />}
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

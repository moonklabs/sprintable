// @vitest-environment jsdom
//
// story #2888(S2·R5) — ReadingPanel 스택(push/pop·브레드크럼) 회귀가드. EntityPreviewModal/
// FileViewer 자체 로직은 각자 테스트가 있다 — 여기는 스택 렌더·네비게이션만 잰다(fetch는
// 실패 스텁 — 어차피 graceful fallback으로 떨어지고, 이 테스트의 관심사가 아니다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReadingPanel, type ReadingPanelTarget } from './reading-panel';

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ projectMemberships: [] }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

const A: ReadingPanelTarget = { kind: 'entity', entityType: 'story', entityId: 's-1', title: '스토리 A', status: null, href: null };
const B: ReadingPanelTarget = { kind: 'entity', entityType: 'doc', entityId: 'd-1', title: '문서 B', status: null, href: null };
const C: ReadingPanelTarget = { kind: 'entity', entityType: 'epic', entityId: 'e-1', title: '목표 C', status: null, href: null };

describe('ReadingPanel 스택 — story #2888 R5', () => {
  it('스택 1개면 브레드크럼을 안 그린다', async () => {
    await act(async () => {
      root.render(<ReadingPanel stack={[A]} onNavigateTo={() => {}} onClose={() => {}} />);
    });
    expect(container.querySelector('[title="전체 닫기"]')).toBeNull();
    expect(container.textContent).toContain('스토리 A');
  });

  it('스택 2개 이상이면 브레드크럼에 전 항목이 순서대로 뜬다(최상단은 굵게·비활성)', async () => {
    await act(async () => {
      root.render(<ReadingPanel stack={[A, B]} onNavigateTo={() => {}} onClose={() => {}} />);
    });
    const buttons = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent?.trim());
    expect(buttons.map((b) => b.textContent)).toEqual(['스토리 A', '문서 B']);
    expect(buttons[1]!.disabled).toBe(true);
    expect(buttons[0]!.disabled).toBe(false);
  });

  it('브레드크럼 세그먼트를 클릭하면 그 인덱스로 onNavigateTo가 호출된다', async () => {
    const onNavigateTo = vi.fn();
    await act(async () => {
      root.render(<ReadingPanel stack={[A, B, C]} onNavigateTo={onNavigateTo} onClose={() => {}} />);
    });
    const firstSegment = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '스토리 A')!;
    await act(async () => { firstSegment.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onNavigateTo).toHaveBeenCalledWith(0);
  });

  it('전체 닫기(X) 클릭 시 onClose가 호출된다', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<ReadingPanel stack={[A, B]} onNavigateTo={() => {}} onClose={onClose} />);
    });
    const closeBtn = container.querySelector('[title="전체 닫기"]') as HTMLButtonElement;
    await act(async () => { closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('최상단 항상 렌더 — 3단 스택에서도 C(최신)의 내용이 본문에 보인다', async () => {
    await act(async () => {
      root.render(<ReadingPanel stack={[A, B, C]} onNavigateTo={() => {}} onClose={() => {}} />);
    });
    // EntityPreviewModal embedded 헤더가 최상단 라벨을 그린다(본문 영역 — 브레드크럼과 별개).
    const headerLabel = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === '목표 C');
    expect(headerLabel).toBeTruthy();
  });

  it('빈 스택이면 아무것도 렌더하지 않는다', async () => {
    await act(async () => {
      root.render(<ReadingPanel stack={[]} onNavigateTo={() => {}} onClose={() => {}} />);
    });
    expect(container.firstChild).toBeNull();
  });
});

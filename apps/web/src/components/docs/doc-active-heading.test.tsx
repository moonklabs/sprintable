// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useActiveDocHeading } from './doc-active-heading';
import type { DocHeading } from './doc-heading-utils';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// story #f546601e — jsdom엔 IntersectionObserver가 없다. observe() 호출을 기록하고
// 테스트가 콜백을 수동으로 트리거할 수 있도록 최소 스텁만 제공한다(실제 브라우저 교차
// 판정 로직 자체는 재구현하지 않음 — 훅이 "관찰 대상을 올바르게 등록하고 콜백 결과를
// activeId로 반영하는지"만 검증 대상).
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  observed: Element[] = [];
  disconnected = false;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: Element) { this.observed.push(el); }
  unobserve() {}
  disconnect() { this.disconnected = true; }
}

const HEADINGS: DocHeading[] = [
  { id: 'a', text: 'A', level: 1 },
  { id: 'b', text: 'B', level: 1 },
  { id: 'c', text: 'C', level: 1 },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  MockIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

function Harness({ headings }: { headings: DocHeading[] }) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const activeId = useActiveDocHeading(contentRef, headings);
  return (
    <div>
      <div ref={contentRef}>
        {headings.map((h) => <h2 id={h.id} key={h.id}>{h.text}</h2>)}
      </div>
      <span data-testid="active">{activeId ?? 'none'}</span>
    </div>
  );
}

async function mount(headings: DocHeading[]) {
  await act(async () => { root.render(<Harness headings={headings} />); });
}

function activeText() {
  return container.querySelector('[data-testid="active"]')?.textContent;
}

describe('useActiveDocHeading (story #f546601e — 우측 미니 TOC 현위치 하이라이트)', () => {
  it('마운트 시 컨테이너 안의 모든 헤딩 요소를 observe한다', async () => {
    await mount(HEADINGS);
    const observer = MockIntersectionObserver.instances[0]!;
    expect(observer.observed.map((el) => el.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('교차한 헤딩 중 뷰포트 상단에 가장 가까운 것을 활성으로 반영한다', async () => {
    await mount(HEADINGS);
    const observer = MockIntersectionObserver.instances[0]!;
    const elA = container.querySelector('#a')!;
    const elB = container.querySelector('#b')!;

    await act(async () => {
      observer.callback(
        [
          { isIntersecting: true, boundingClientRect: { top: 120 } as DOMRect, target: elA } as IntersectionObserverEntry,
          { isIntersecting: true, boundingClientRect: { top: 20 } as DOMRect, target: elB } as IntersectionObserverEntry,
        ],
        observer as unknown as IntersectionObserver,
      );
    });

    expect(activeText()).toBe('b');
  });

  it('교차 중인 헤딩이 없으면(빈 entries) 이전 activeId를 유지한다(깜빡임 방지)', async () => {
    await mount(HEADINGS);
    const observer = MockIntersectionObserver.instances[0]!;
    const elA = container.querySelector('#a')!;

    await act(async () => {
      observer.callback(
        [{ isIntersecting: true, boundingClientRect: { top: 10 } as DOMRect, target: elA } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      );
    });
    expect(activeText()).toBe('a');

    await act(async () => {
      observer.callback([], observer as unknown as IntersectionObserver);
    });
    expect(activeText()).toBe('a');
  });

  it('헤딩이 없으면 observe하지 않고 activeId는 null이다', async () => {
    await mount([]);
    expect(MockIntersectionObserver.instances).toHaveLength(0);
    expect(activeText()).toBe('none');
  });

  it('언마운트 시 observer를 disconnect한다(메모리 누수 방지)', async () => {
    const localContainer = document.createElement('div');
    document.body.appendChild(localContainer);
    const localRoot = createRoot(localContainer);
    await act(async () => { localRoot.render(<Harness headings={HEADINGS} />); });

    const observer = MockIntersectionObserver.instances[0]!;
    await act(async () => { localRoot.unmount(); });
    localContainer.remove();

    expect(observer.disconnected).toBe(true);
  });
});

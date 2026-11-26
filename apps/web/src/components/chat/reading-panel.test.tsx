// @vitest-environment jsdom
//
// story #2888(S2·R5) — ReadingPanel 스택(push/pop·브레드크럼) 회귀가드. EntityPreviewModal/
// FileViewer 자체 로직은 각자 테스트가 있다 — 여기는 스택 렌더·네비게이션만 잰다(fetch는
// 실패 스텁 — 어차피 graceful fallback으로 떨어지고, 이 테스트의 관심사가 아니다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ReadingPanel, type ReadingPanelTarget } from './reading-panel';
import koMessages from '../../../messages/ko.json';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

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

describe('ReadingPanel 창 전체 단 — story 5034 (C4)', () => {
  it('핸들러를 안 주면 «창 전체» 단추가 없다(그런 모드가 없는 호스트) — 옛 호출부 그대로', async () => {
    await act(async () => { root.render(wrap(<ReadingPanel stack={[A]} onNavigateTo={() => {}} onClose={() => {}} />)); });
    expect(container.querySelector('[aria-label="창 전체로 보기"]')).toBeNull();
    expect(container.querySelector('.overflow-x-auto')).toBeNull(); // and no empty bar over the content either
  });
  it('주면 «창 전체로 보기»(눌림 아님)가 뜨고, 누르면 핸들러가 불린다 · 넓힌 뒤엔 «옆 패널로 줄이기»(눌림)로 바뀐다', async () => {
    const toggle = vi.fn();
    await act(async () => { root.render(wrap(<ReadingPanel stack={[A]} onNavigateTo={() => {}} onClose={() => {}} expanded={false} onToggleExpanded={toggle} />)); });
    const btn = container.querySelector('[aria-label="창 전체로 보기"]') as HTMLButtonElement;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { btn.click(); });
    expect(toggle).toHaveBeenCalledTimes(1);
    await act(async () => { root.render(wrap(<ReadingPanel stack={[A]} onNavigateTo={() => {}} onClose={() => {}} expanded onToggleExpanded={toggle} />)); });
    const back = container.querySelector('[aria-label="옆 패널로 줄이기"]') as HTMLButtonElement;
    expect(back.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[aria-label="창 전체로 보기"]')).toBeNull();
  });
  it('단추는 넓은 화면에만 보인다(폰은 패널이 이미 화면 전체) · 스택이 깊어도 «전체 닫기»는 그대로 있다', async () => {
    await act(async () => { root.render(wrap(<ReadingPanel stack={[A, B]} onNavigateTo={() => {}} onClose={() => {}} onToggleExpanded={() => {}} />)); });
    expect((container.querySelector('[aria-label="창 전체로 보기"]') as HTMLElement).className).toContain('max-lg:hidden');
    expect(container.querySelector('[title="전체 닫기"]')).not.toBeNull();
  });
});

describe('ReadingPanel 스택 — story #2888 R5', () => {
  it('스택 1개면 브레드크럼을 안 그린다', async () => {
    await act(async () => {
      root.render(wrap(<ReadingPanel stack={[A]} onNavigateTo={() => {}} onClose={() => {}} />));
    });
    expect(container.querySelector('[title="전체 닫기"]')).toBeNull();
    expect(container.textContent).toContain('스토리 A');
  });

  it('스택 2개 이상이면 브레드크럼에 전 항목이 순서대로 뜬다(최상단은 굵게·비활성)', async () => {
    await act(async () => {
      root.render(wrap(<ReadingPanel stack={[A, B]} onNavigateTo={() => {}} onClose={() => {}} />));
    });
    const buttons = Array.from(container.querySelectorAll('button')).filter((b) => b.textContent?.trim());
    expect(buttons.map((b) => b.textContent)).toEqual(['스토리 A', '문서 B']);
    expect(buttons[1]!.disabled).toBe(true);
    expect(buttons[0]!.disabled).toBe(false);
  });

  it('브레드크럼 세그먼트를 클릭하면 그 인덱스로 onNavigateTo가 호출된다', async () => {
    const onNavigateTo = vi.fn();
    await act(async () => {
      root.render(wrap(<ReadingPanel stack={[A, B, C]} onNavigateTo={onNavigateTo} onClose={() => {}} />));
    });
    const firstSegment = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '스토리 A')!;
    await act(async () => { firstSegment.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onNavigateTo).toHaveBeenCalledWith(0);
  });

  it('전체 닫기(X) 클릭 시 onClose가 호출된다', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(wrap(<ReadingPanel stack={[A, B]} onNavigateTo={() => {}} onClose={onClose} />));
    });
    const closeBtn = container.querySelector('[title="전체 닫기"]') as HTMLButtonElement;
    await act(async () => { closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('최상단 항상 렌더 — 3단 스택에서도 C(최신)의 내용이 본문에 보인다', async () => {
    await act(async () => {
      root.render(wrap(<ReadingPanel stack={[A, B, C]} onNavigateTo={() => {}} onClose={() => {}} />));
    });
    // EntityPreviewModal embedded 헤더가 최상단 라벨을 그린다(본문 영역 — 브레드크럼과 별개).
    const headerLabel = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === '목표 C');
    expect(headerLabel).toBeTruthy();
  });

  it('빈 스택이면 아무것도 렌더하지 않는다', async () => {
    await act(async () => {
      root.render(wrap(<ReadingPanel stack={[]} onNavigateTo={() => {}} onClose={() => {}} />));
    });
    expect(container.firstChild).toBeNull();
  });

  // story #2910(S2f/R3) — 스택 top 전환(push/pop) 시 slide-up+fade가 자연 발화하는 자리
  // (key로 리마운트되는 그 wrapper)에 motion-safe: 게이팅 클래스가 실려 있는지.
  it('스택 top 콘텐츠 wrapper에 motion-safe 전환 클래스가 실려 있다(reduce-motion 자동 제거)', async () => {
    await act(async () => {
      root.render(wrap(<ReadingPanel stack={[A]} onNavigateTo={() => {}} onClose={() => {}} />));
    });
    const wrapper = container.querySelector('.motion-safe\\:animate-in');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toContain('motion-safe:slide-in-from-bottom-2');
    expect(wrapper?.className).toContain('motion-safe:fade-in');
  });
});

// story #2904 — 카디르+codex #3303 QA 확定: popOne(최상단 콘텐츠 자기 X)의 "pop-vs-close"
// 분기가 뮤테이션 무감지였다(정적 렌더 테스트만 있고 이 클릭 자체를 아무 테스트도 안 눌렀음).
// EntityPreviewModal(embedded) 헤더의 실 닫기 버튼(aria-label="닫기")을 직접 클릭해 왕복 검증.
describe('ReadingPanel — story #2904 동역학 ③ popOne(최상단 자기 X) pop-vs-close', () => {
  it('스택 2단 이상 — 콘텐츠 자기 닫기는 onClose가 아니라 onNavigateTo(length-2)를 호출한다', async () => {
    const onNavigateTo = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(wrap(<ReadingPanel stack={[A, B, C]} onNavigateTo={onNavigateTo} onClose={onClose} />));
    });
    const contentCloseBtn = container.querySelector('[aria-label="닫기"]') as HTMLButtonElement;
    expect(contentCloseBtn).not.toBeNull();
    await act(async () => { contentCloseBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onNavigateTo).toHaveBeenCalledWith(1); // stack.length(3) - 2
    expect(onClose).not.toHaveBeenCalled();
  });

  it('스택 1단뿐 — 콘텐츠 자기 닫기는 onNavigateTo가 아니라 onClose를 호출한다(전체 닫기와 동형)', async () => {
    const onNavigateTo = vi.fn();
    const onClose = vi.fn();
    await act(async () => {
      root.render(wrap(<ReadingPanel stack={[A]} onNavigateTo={onNavigateTo} onClose={onClose} />));
    });
    const contentCloseBtn = container.querySelector('[aria-label="닫기"]') as HTMLButtonElement;
    expect(contentCloseBtn).not.toBeNull();
    await act(async () => { contentCloseBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onNavigateTo).not.toHaveBeenCalled();
  });
});

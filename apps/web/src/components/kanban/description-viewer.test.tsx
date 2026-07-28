// @vitest-environment jsdom
//
// 긴급 정정(2026-07-28, PO 검수 실패) — story-detail-panel.tsx의 description/AC 뷰어는
// 부모 div에 「클릭=편집모드 진입」 onClick이 걸려 있다. 그 안의 markdown 링크가
// stopPropagation 없이 렌더돼 링크 클릭이 부모까지 버블링, 새 탭이 열리는 동시에
// 편집모드까지 열리던 결함(#2258과 무관 — 컴포넌트 레벨 사전 존재 결함). DescriptionViewer는
// StoryDetailPanel 전체 마운트 없이 격리 테스트 가능하도록 export됐다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DescriptionViewer } from './story-detail-panel';

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

describe('DescriptionViewer — 본문 링크 클릭이 부모(편집모드 진입) onClick으로 안 새는지', () => {
  it('링크를 클릭해도 부모 wrapper의 onClick(편집모드 진입)이 발화하지 않는다', async () => {
    let parentClicked = false;
    await act(async () => {
      root.render(
        // story-detail-panel.tsx:1093/1140과 동일한 실제 wrapper 패턴 재현.
        <div onClick={() => { parentClicked = true; }}>
          <DescriptionViewer description="문서 보기: [연결된 doc](https://sprintable.example/docs/some-doc)" />
        </div>,
      );
    });

    const link = container.querySelector('a') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('https://sprintable.example/docs/some-doc');

    // jsdom에서 실제 새 탭 네비게이션은 일어나지 않지만, React 합성이벤트 버블링 여부는 검증 가능.
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(parentClicked).toBe(false);
  });

  it('(양성대조) 링크가 아닌 본문 텍스트를 클릭하면 부모 onClick은 정상적으로 발화한다', async () => {
    let parentClicked = false;
    await act(async () => {
      root.render(
        <div onClick={() => { parentClicked = true; }}>
          <DescriptionViewer description="그냥 본문 텍스트입니다." />
        </div>,
      );
    });

    const p = container.querySelector('p') as HTMLParagraphElement;
    await act(async () => {
      p.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(parentClicked).toBe(true);
  });
});

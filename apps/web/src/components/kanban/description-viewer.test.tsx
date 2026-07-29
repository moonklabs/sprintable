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

// story #2269(C-11) AC0-2 보너스 발견 — rehypeSanitize의 defaultSchema가 `entity:` scheme을
// href protocol 허용 목록에 안 둬 EntityChip 새 형식 링크가 href=null로 무력화됐었다.
// entity 하나만 허용 목록에 추가한 스키마로 고친 결과를 검증한다.
describe('DescriptionViewer — entity: 링크가 EntityChip으로 그려지는지(AC0-2 보너스 수정)', () => {
  const STORY_ID = '11111111-1111-1111-1111-111111111111';

  it('references에 매칭되는 대상이 있으면 정상 칩(비-유령)으로 그린다', async () => {
    await act(async () => {
      root.render(
        <DescriptionViewer
          description={`이건 [스토리 제목](entity:story:${STORY_ID}) 참조인지라.`}
          references={[{ target_type: 'story', target_id: STORY_ID }]}
        />,
      );
    });

    // 유령이면 '대상이 없습니다' 텍스트로 바뀐다 — 정상 칩은 label 그대로 유지.
    expect(container.textContent).toContain('스토리 제목');
    expect(container.textContent).not.toContain('대상이 없습니다');
    expect(container.querySelector('button')).toBeTruthy();
  });

  it('references에 없는 대상이면 유령 칩(회색·클릭 불가)으로 그린다', async () => {
    await act(async () => {
      root.render(
        <DescriptionViewer
          description={`이건 [스토리 제목](entity:story:${STORY_ID}) 참조인지라.`}
          references={[]}
        />,
      );
    });

    expect(container.textContent).toContain('대상이 없습니다');
    // 유령 칩은 button(모달 진입)이 없다 — embed-card.tsx EntityChip의 ghost 분기.
    expect(container.querySelector('button')).toBeFalsy();
  });

  it('references가 undefined(미로드)면 유령 판정을 보류하고 정상 칩으로 그린다(#2622와 동형 폴백)', async () => {
    await act(async () => {
      root.render(
        <DescriptionViewer description={`이건 [스토리 제목](entity:story:${STORY_ID}) 참조인지라.`} />,
      );
    });

    expect(container.textContent).toContain('스토리 제목');
    expect(container.textContent).not.toContain('대상이 없습니다');
  });

  it('entity: 링크 클릭도 부모(편집모드 진입) onClick으로 안 샌다', async () => {
    let parentClicked = false;
    await act(async () => {
      root.render(
        <div onClick={() => { parentClicked = true; }}>
          <DescriptionViewer
            description={`[스토리 제목](entity:story:${STORY_ID})`}
            references={[{ target_type: 'story', target_id: STORY_ID }]}
          />
        </div>,
      );
    });

    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button).toBeTruthy();
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(parentClicked).toBe(false);
  });
});

// ⛔뮤테이션 자가검증(PO 지시, 2026-07-29) — 「entity 스킴만 열었다」는 이 테스트가 안 서면
// «주장»에 불과하다. entity: 하나만 허용 목록에 더했을 뿐, javascript:/data: 등 원래
// defaultSchema가 막던 스킴은 그대로 막혀야 한다.
describe('DescriptionViewer — entity: 허용 목록 추가가 다른 위험 scheme까지 안 여는지(뮤테이션 자가검증)', () => {
  it('javascript: href는 sanitize로 여전히 제거된다', async () => {
    await act(async () => {
      root.render(
        <DescriptionViewer description="[클릭](javascript:alert(1))" />,
      );
    });

    const link = container.querySelector('a');
    expect(link).toBeTruthy();
    expect(link!.getAttribute('href')).toBeNull();
  });

  it('data: href도 sanitize로 여전히 제거된다', async () => {
    await act(async () => {
      root.render(
        <DescriptionViewer description="[클릭](data:text/html,<script>alert(1)</script>)" />,
      );
    });

    const link = container.querySelector('a');
    expect(link).toBeTruthy();
    expect(link!.getAttribute('href')).toBeNull();
  });

  it('일반 https: href는 그대로 통과한다(회귀 없음)', async () => {
    await act(async () => {
      root.render(
        <DescriptionViewer description="[문서](https://sprintable.example/x)" />,
      );
    });

    const link = container.querySelector('a');
    expect(link!.getAttribute('href')).toBe('https://sprintable.example/x');
  });
});

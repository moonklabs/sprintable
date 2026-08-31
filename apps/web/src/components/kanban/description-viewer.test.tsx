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

  it('references에 없는 대상이면 유령 칩(회색)으로 그린다 — story #3213: entityId가 있으므로 클릭 가능·실 라벨 유지', async () => {
    await act(async () => {
      root.render(
        <DescriptionViewer
          description={`이건 [스토리 제목](entity:story:${STORY_ID}) 참조인지라.`}
          references={[]}
        />,
      );
    });

    // entityId가 UUID까지 파싱됐다 — 미등록≠비존재라 "대상이 없습니다" 단정 없이 실 라벨을
    // 보이고, 클릭(EntityChip→EntityPreviewModal 실 fetch)으로 진짜 존재판정을 위임한다.
    expect(container.textContent).not.toContain('대상이 없습니다');
    expect(container.textContent).toContain('스토리 제목');
    expect(container.querySelector('button')).toBeTruthy();
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

// story #2269(C-11) AC0-2 축B — bare_number_targets(번호→story_id)를 이용한 render-time
// #<번호> 치환. 축A(entity_references 관찰수집)만으로는 화면에 아무것도 안 뜬다는 PO 지적
// (2026-07-29)을 반영한 실제 표시 레이어.
describe('DescriptionViewer — bare #<번호>가 bareNumberTargets로 렌더되는지(AC0-2 축B)', () => {
  const TARGET_ID = '22222222-2222-2222-2222-222222222222';

  it('bareNumberTargets에 매칭되는 번호는 정상 칩으로 그린다', async () => {
    await act(async () => {
      root.render(
        <DescriptionViewer
          description="이건 #2258 참조인지라"
          bareNumberTargets={{ '2258': TARGET_ID }}
        />,
      );
    });

    expect(container.textContent).toContain('#2258');
    expect(container.textContent).not.toContain('대상이 없습니다');
    expect(container.querySelector('button')).toBeTruthy();
  });

  it('bareNumberTargets에 없는 번호(미해소)는 유령 칩으로 그린다 — «삭제됨»이 아니라 시제 중립 문구', async () => {
    await act(async () => {
      root.render(
        <DescriptionViewer
          description="이건 #9999 참조인지라"
          bareNumberTargets={{}}
        />,
      );
    });

    expect(container.textContent).toContain('대상이 없습니다');
    expect(container.textContent).not.toContain('삭제');
    expect(container.querySelector('button')).toBeFalsy();
  });

  it('bareNumberTargets가 undefined(미로드)면 치환을 보류하고 #<번호>가 평문 그대로 남는다', async () => {
    await act(async () => {
      root.render(<DescriptionViewer description="이건 #2258 참조인지라" />);
    });

    expect(container.textContent).toContain('#2258');
    expect(container.textContent).not.toContain('대상이 없습니다');
    expect(container.querySelector('button')).toBeFalsy();
    expect(container.querySelector('a')).toBeFalsy();
  });

  it('여러 번호 중 일부만 해소돼도 각자 독립적으로 정상/유령을 가른다', async () => {
    await act(async () => {
      root.render(
        <DescriptionViewer
          description="해소됨 #100, 미해소 #200"
          bareNumberTargets={{ '100': TARGET_ID }}
        />,
      );
    });

    const html = container.innerHTML;
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(1);
    expect(html).toContain('대상이 없습니다');
  });

  it('코드블록 안의 #<번호>는 치환되지 않는다(AC0-3 세는 정의)', async () => {
    await act(async () => {
      root.render(
        <DescriptionViewer
          description={'실참조 #100.\n```\n예시 #200\n```'}
          bareNumberTargets={{ '100': TARGET_ID, '200': TARGET_ID }}
        />,
      );
    });

    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(1); // #100만 칩, #200은 코드블록 안이라 평문
    expect(container.querySelector('code')?.textContent).toContain('#200');
  });

  it('bare-number: 링크 클릭도 부모(편집모드 진입) onClick으로 안 샌다', async () => {
    let parentClicked = false;
    await act(async () => {
      root.render(
        <div onClick={() => { parentClicked = true; }}>
          <DescriptionViewer description="#2258" bareNumberTargets={{ '2258': TARGET_ID }} />
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

// ⛔뮤테이션 자가검증(PO 지시 패턴 재사용) — `bare-number:` 스킴 추가가 다른 위험 scheme까지
// 안 여는지.
describe('DescriptionViewer — bare-number: 허용 목록 추가가 다른 위험 scheme까지 안 여는지', () => {
  it('bareNumberTargets가 있어도 javascript: href는 여전히 제거된다(치환 대상 아닌 일반 링크)', async () => {
    await act(async () => {
      root.render(
        <DescriptionViewer
          description="[클릭](javascript:alert(1))"
          bareNumberTargets={{ '1': '11111111-1111-1111-1111-111111111111' }}
        />,
      );
    });

    const link = container.querySelector('a');
    expect(link).toBeTruthy();
    expect(link!.getAttribute('href')).toBeNull();
  });
});

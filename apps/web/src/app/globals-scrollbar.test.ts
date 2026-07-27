import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// story #2165(2026-07-25, 까심 QA): 제품 전역 스크롤바 숨김 + 코드블럭/표 예외. CSS는 jsdom으로
// 렌더 검증이 안 돼(실제 스크롤바 렌더는 브라우저 전용) 소스 문자열 불변식으로 고정한다:
// ① 전역 숨김 규칙이 존재 ② .scrollbar-visible 예외 클래스가 그것을 되살림 ③ 스크롤 "기능"
// 자체를 막는 overflow:hidden으로 되어있지 않음(숨기는 것과 못 굴리게 하는 것은 다르다).
const css = fs.readFileSync(
  path.resolve(__dirname, 'globals.css'),
  'utf8',
);

describe('전역 스크롤바 숨김 CSS 불변식 (#2165)', () => {
  it('전역 * 규칙이 scrollbar-width:none + webkit scrollbar display:none 이다', () => {
    expect(css).toMatch(/\*\s*\{\s*scrollbar-width:\s*none;\s*\}/);
    expect(css).toContain('*::-webkit-scrollbar { display: none; }');
  });

  it('.scrollbar-visible 이 scrollbar-width:thin으로 되살리고 overflow는 건드리지 않는다', () => {
    expect(css).toMatch(/\.scrollbar-visible[^{]*\{[^}]*scrollbar-width:\s*thin/);
    expect(css).not.toMatch(/\.scrollbar-visible[^{]*\{[^}]*overflow:\s*hidden/);
  });

  it('.doc-renderer pre 후손 선택자도 같은 예외를 받는다(raw HTML 주입 경로라 클래스 직접 부착 불가)', () => {
    expect(css).toMatch(/\.doc-renderer pre[^{]*\{[^}]*scrollbar-width:\s*thin|\.scrollbar-visible,\s*\n?\s*\.doc-renderer pre/);
  });
});

describe('.tableWrapper(TipTap 테이블 노드뷰 기본 클래스)가 실제로 가로 스크롤 가능하다 (#2203)', () => {
  it('overflow-x:auto가 있다 — 이게 본체(스크롤바 노출만으로는 여전히 안 굴러간다)', () => {
    expect(css).toMatch(/\.tableWrapper\s*\{[^}]*overflow-x:\s*auto/);
  });

  it('overflow-x:visible이나 overflow-x:hidden으로 되어있지 않다(#2203 원 결함 재발 방지)', () => {
    expect(css).not.toMatch(/\.tableWrapper\s*\{[^}]*overflow-x:\s*(visible|hidden)/);
  });

  it('scrollbar-visible과 같은 예외(scrollbar-width:thin)를 받는다', () => {
    expect(css).toMatch(/\.tableWrapper[^{]*\{[^}]*scrollbar-width:\s*thin|\.scrollbar-visible,[\s\S]*?\.tableWrapper\s*\{/);
  });
});

describe('문서 코드블럭이 실제로 "굴러갈 수 있다" — .ProseMirror pre-wrap을 코드블럭만 덮는다 (#2214)', () => {
  it('.ProseMirror .scrollbar-visible pre가 white-space:pre로 덮는다(라이브러리 base pre-wrap 무력화)', () => {
    expect(css).toMatch(/\.ProseMirror \.scrollbar-visible pre\s*\{[^}]*white-space:\s*pre[^-]/);
  });

  it('overflow-wrap도 normal로 되돌린다(조상 .ProseMirror의 break-word 상속 차단)', () => {
    expect(css).toMatch(/\.ProseMirror \.scrollbar-visible pre\s*\{[^}]*overflow-wrap:\s*normal/);
  });

  it('⛔안전장치 — max-width:100%+min-width:0이 white-space:pre보다 먼저 나온다(#2035류 body 밀림 방지)', () => {
    const safetyIdx = css.indexOf('.ProseMirror .scrollbar-visible {');
    const bodyIdx = css.indexOf('.ProseMirror .scrollbar-visible pre {');
    expect(safetyIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(safetyIdx).toBeLessThan(bodyIdx);
    const safetyBlock = css.slice(safetyIdx, bodyIdx);
    expect(safetyBlock).toMatch(/max-width:\s*100%/);
    expect(safetyBlock).toMatch(/min-width:\s*0/);
  });

  it('산문·인용·표 selector는 이 규칙에 안 걸린다(코드블럭 scrollbar-visible 래퍼만 특이도를 올림)', () => {
    // .ProseMirror .scrollbar-visible 자체가 code-block-copy.tsx 전용 클래스 조합이라, 이
    // selector 문자열 자체에 prose(p)나 blockquote·table 태그가 안 섞여 있어야 한다.
    expect(css).not.toMatch(/\.ProseMirror \.scrollbar-visible[^{]*[,\s](p|blockquote|table)[,\s{]/);
  });
});

describe('실제 스크롤 요소(shiki가 만드는 <pre> 자신)에도 scrollbar-visible 예외가 있다 (#2214 후속, 라이브 실측 발견)', () => {
  // 라이브 실측(2026-07-27): 바깥 `.scrollbar-visible` wrapper div가 아니라 그 안의
  // `<pre class="shiki ...">` 자신이 실제로 scrollLeft가 움직이는 요소였다(shiki 산출물 자체에
  // overflow-x:auto가 붙어 내용이 pre 안에서 스스로 스크롤되고 바깥 wrapper의 scrollWidth에는
  // 반영 안 됨 — wrapper는 scrollWidth===clientWidth로 남는다). 그 pre 자신에 scrollbar-width
  // 예외가 없으면 "굴러가긴 하는데 스크롤바만 안 보이는" 반쪽 상태가 된다.
  it('.ProseMirror .scrollbar-visible pre에 scrollbar-width:thin 예외가 있다', () => {
    expect(css).toMatch(/\.ProseMirror \.scrollbar-visible pre\s*\{[^}]*scrollbar-width:\s*thin/);
  });

  it('webkit 스크롤바 규칙(track·thumb·hover)도 같은 selector로 붙어 있다', () => {
    expect(css).toMatch(/\.ProseMirror \.scrollbar-visible pre::-webkit-scrollbar\s*\{[^}]*display:\s*block/);
    expect(css).toMatch(/\.ProseMirror \.scrollbar-visible pre::-webkit-scrollbar-thumb\s*\{/);
  });
});

describe('코드블럭/표 wrapper가 scrollbar-visible을 잃지 않았다 (#2165)', () => {
  const files = [
    'docs/extensions/code-block-copy.tsx',
    'docs/doc-content-renderer.tsx',
    'chat/chat-bubble.tsx',
    'chat/embed-card.tsx',
    'kanban/story-detail-panel.tsx',
    'agents/access-matrix-tab.tsx',
    'settings/workflow-execution-history-section.tsx',
  ];

  for (const file of files) {
    it(`components/${file} 안에 scrollbar-visible 클래스가 존재한다`, () => {
      const content = fs.readFileSync(
        path.resolve(__dirname, '../components', file),
        'utf8',
      );
      expect(content).toContain('scrollbar-visible');
    });
  }
});

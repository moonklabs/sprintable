import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { contrastRatio } from '../lib/color-contrast';

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

  // story #2229(라이브 실측, 2026-07-27) — #2214가 편집기 뷰(실 ProseMirror 런타임)에서
  // 절반만 먹혔다. 이 규칙이 @layer base **안**에 있었기 때문 — prosemirror-view가 런타임에
  // 주입하는 `.ProseMirror pre { white-space: pre-wrap }`은 레포 어디에도 소스가 없는(런타임
  // <style> 직접 주입) **레이어 밖(unlayered)** 규칙이라, CSS Cascade Layers 스펙상 특이도와
  // 무관하게 레이어 안 규칙을 항상 이긴다. #2203(.tableWrapper)이 같은 @layer base 안에서도
  // 먹혔던 건 그저 경쟁 규칙이 없었기 때문일 뿐 — "레이어 안에서도 이긴다"는 증거가 아니었다.
  // ⛔이 테스트는 "CSS 문자열이 있는가"만 볼 수 있고 "실제로 이겼는가"(computed style)는
  // jsdom이 CSS 레이아웃을 안 돌려 원리적으로 못 잡는다 — 그 축은 라이브/실브라우저 렌더로만
  // 확인 가능(#2229에서 정적 HTML 재현으로 검증 완료, 라이브 배포 확認은 별도).
  it('⛔.ProseMirror .scrollbar-visible 규칙은 @layer base 안에 있지 않다(레이어 밖이어야 라이브러리 런타임 주입 스타일을 이긴다)', () => {
    const layerBaseStart = css.indexOf('@layer base {');
    expect(layerBaseStart).toBeGreaterThan(-1);
    let depth = 0;
    let layerBaseEnd = -1;
    for (let i = layerBaseStart; i < css.length; i++) {
      if (css[i] === '{') depth++;
      if (css[i] === '}') {
        depth--;
        if (depth === 0) { layerBaseEnd = i; break; }
      }
    }
    expect(layerBaseEnd).toBeGreaterThan(-1);
    const layerBaseBlock = css.slice(layerBaseStart, layerBaseEnd);
    expect(layerBaseBlock).not.toContain('.ProseMirror .scrollbar-visible');
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

// story #2601 — 픽셀 fixture는 실 Chromium canvas 2d(fillRect+getImageData)로 캡처했다
// (2026-08-13, Puppeteer, color-contrast.test.ts와 동일 규격). 원래 값(라이트 10%/다크 8%
// 알파)은 대비 ~1.2:1로 사실상 안 보였다(story 원 결함) — 45%/65%(hover 65%/80%)로 올려
// 3:1(WCAG 비텍스트 UI 컴포넌트 문턱) 이상을 확保. ⛔jsdom은 실 canvas 렌더를 안 하므로
// oklch 알파합성을 여기서 재현하지 않는다 — 이미 sRGB로 환산된 실측 RGB를 고정값으로 쓴다.
const LIGHT_BG = [255, 255, 255] as const; // --background(light) = oklch(1 0 0)
const LIGHT_THUMB_OLD = [229, 229, 229] as const; // oklch(0 0 0 / 10%) — 원 결함
const LIGHT_THUMB = [140, 140, 140] as const; // oklch(0 0 0 / 45%)
const DARK_BG = [17, 17, 20] as const; // --background(dark) = oklch(0.18 0.005 285.823)
const DARK_THUMB_OLD = [36, 36, 39] as const; // oklch(1 0 0 / 8%) — 원 결함
const DARK_THUMB = [172, 172, 173] as const; // oklch(1 0 0 / 65%)

describe('스크롤바 썸/배경 대비 (#2601 — «스크롤바 미표시» 실은 대비 실패)', () => {
  it('양성대조 — 원래 값(10%/8% 알파)은 실측 대비 ~1.2:1로 3:1 미달이었다(원 결함 재현)', () => {
    expect(contrastRatio(LIGHT_BG, LIGHT_THUMB_OLD)).toBeLessThan(1.5);
    expect(contrastRatio(DARK_BG, DARK_THUMB_OLD)).toBeLessThan(1.5);
  });

  it('light: 새 썸(45% 알파)이 배경과 3:1 이상 — WCAG 비텍스트 UI 컴포넌트 문턱', () => {
    expect(contrastRatio(LIGHT_BG, LIGHT_THUMB)).toBeGreaterThanOrEqual(3);
  });

  it('dark: 새 썸(65% 알파)이 배경과 3:1 이상', () => {
    expect(contrastRatio(DARK_BG, DARK_THUMB)).toBeGreaterThanOrEqual(3);
  });

  it('회귀 가드 — --background 값이 이 값 그대로일 때만 위 판정이 유효하다(값이 바뀌면 재실측 필요)', () => {
    const css = fs.readFileSync(path.resolve(__dirname, 'globals.css'), 'utf8');
    expect(css).toContain('--background: oklch(1 0 0);');
    expect(css).toContain('--background: oklch(0.18 0.005 285.823);');
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

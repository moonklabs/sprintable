// story #3756 AC1 — 셸이 `--bottom-dock-inset`/`--mobile-tab-bar-h`를 실제로 «세우는» 자리
// 3곳(dashboard-shell.tsx가 소유 클래스를 부착·mobile-tab-bar.tsx가 높이 토큰을 소비·
// globals.css가 변수 정의+media query)을 소스 텍스트 수준에서 고정. bottom-dock-inset.
// guard.test.ts는 "소비처가 변수를 참조하는가"를, 이 파일은 "그 변수가 실제로 어딘가에서
// 세워지는가"를 각각 담당(계약의 양쪽 절반 — 세우는 쪽 없이 참조만 있으면 무의미한 var()라
// 이 짝이 꼭 필요하다).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(__dirname, '../');

function read(relativePath: string): string {
  return readFileSync(join(SRC_ROOT, relativePath), 'utf-8');
}

// story #3759 CHANGES 3차 — 코드 주석 자체가 지난 회귀(min-h-[5.5rem])를 설명하려고 그
// 리터럴을 그대로 인용한다. "그 리터럴이 코드에 없다"를 재는 negative-match 정규식이
// 그 설명 줄까지 걸리면 오탐이다(bottom-dock-inset.guard.test.ts COMMENT_LINE_RE와
// 동형 처방) — 순수 코드 줄만 남기고 재는다.
const COMMENT_LINE_RE = /^\s*(\/\/|\*|\{\/\*)/;
function stripCommentLines(content: string): string {
  return content.split('\n').filter((l) => !COMMENT_LINE_RE.test(l)).join('\n');
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !entry.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

describe('dashboard-shell.tsx — SidebarProvider가 dashboard-shell-root 클래스를 부착한다', () => {
  it('SidebarProvider className에 dashboard-shell-root가 있다', () => {
    const content = read('src/app/dashboard/dashboard-shell.tsx');
    expect(content).toMatch(/<SidebarProvider[^>]*className=["'`][^"'`]*\bdashboard-shell-root\b/);
  });
});

describe('mobile-tab-bar.tsx — nav 높이가 --mobile-tab-bar-h 토큰을 참조한다', () => {
  it('h-16 같은 하드코딩이 아니라 h-[var(--mobile-tab-bar-h)]를 쓴다', () => {
    const content = read('src/components/nav/mobile-tab-bar.tsx');
    expect(content).toContain('h-[var(--mobile-tab-bar-h)]');
    expect(content).not.toMatch(/<nav[^>]*className=["'`][^"'`]*\bh-16\b/);
  });
});

describe('globals.css — --bottom-dock-inset·--mobile-tab-bar-h 정의 + lg 미만 media query', () => {
  const css = read('src/app/globals.css');

  it('.dashboard-shell-root가 두 변수를 기본값으로 세운다', () => {
    expect(css).toMatch(/\.dashboard-shell-root\s*\{[^}]*--mobile-tab-bar-h:\s*4rem/);
    expect(css).toMatch(/\.dashboard-shell-root\s*\{[^}]*--bottom-dock-inset:\s*env\(safe-area-inset-bottom\)/);
  });

  it('lg 미만(<1024px, hooks/use-mobile.ts MOBILE_BREAKPOINT와 동일 SSOT)에서 탭 바 높이를 더한다', () => {
    expect(css).toMatch(
      /@media \(max-width: 1023px\)\s*\{\s*\.dashboard-shell-root\s*\{[^}]*--bottom-dock-inset:\s*calc\(var\(--mobile-tab-bar-h\)\s*\+\s*env\(safe-area-inset-bottom\)\)/,
    );
  });

  it('MOBILE_BREAKPOINT(1024)와 media query 경계(1023px)가 어긋나지 않는다', () => {
    const hooks = read('src/hooks/use-mobile.ts');
    const match = hooks.match(/MOBILE_BREAKPOINT\s*=\s*(\d+)/);
    expect(match).not.toBeNull();
    const breakpoint = Number(match![1]);
    // lg:hidden(탭 바)은 min-width:breakpoint에서 사라진다 — 그 직전 정수 px가 media query 상한.
    expect(css).toContain(`@media (max-width: ${breakpoint - 1}px)`);
  });
});

// story #3759 AC1 — 토스트 전역화 + 셸 단일 렌더. 예전엔 <ToastContainer> 렌더 자리가
// 31곳(호출부마다 독립 fixed 좌표)이었다 — 지금은 BottomDock 하나뿐이어야 한다.
describe('<ToastContainer> 렌더 자리 전수 1(story #3759 AC1) — 셸(BottomDock) 하나만', () => {
  it('전 소스 스캔에서 <ToastContainer 렌더가 정확히 1곳, components/nav/bottom-dock.tsx뿐이다', () => {
    const files = listSourceFiles(join(SRC_ROOT, 'src'));
    const hits: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      if (content.includes('<ToastContainer')) {
        hits.push(file.replace(`${SRC_ROOT}src/`, ''));
      }
    }
    expect(hits).toEqual(['components/nav/bottom-dock.tsx']);
  });

  it('DashboardShell이 <ToastProvider>로 감싼다(전역 스토어 마운트 지점)', () => {
    const content = read('src/app/dashboard/dashboard-shell.tsx');
    expect(content).toContain('<ToastProvider>');
    expect(content).toContain("from '@/components/ui/toast'");
  });

  it('DashboardShell이 <BottomDock />를 렌더한다(dashboard-shell-root 스코프 안, 전용 fixed 컬럼 1곳)', () => {
    const content = read('src/app/dashboard/dashboard-shell.tsx');
    expect(content).toContain('<BottomDock />');
  });
});

// story #3759 CHANGES(유나 定+페드루 判, #4106) — 컬럼에 높이 예산이 없어 토스트가 쌓일수록
// 패널이 뷰포트 위로 밀려났다(375×667·토스트 1장에서 패널 top -31, #3756이 세운 "패널
// top ≥ 0" 회귀). 처방(컬럼 max-h+min-h-0 · 패널 max-h-)을 소스 텍스트 수준에서 고정 —
// 되돌리면 이 describe가 RED(jsdom엔 레이아웃 엔진이 없어 실제 겹침/클리핑 자체는 못
// 재므로, 로컬 puppeteer 실측 수치는 bottom-dock.tsx의 코드 주석에 남긴다 — doc-editor.tsx의
// 기존 관례와 동형).
//
// story #3759 CHANGES 2차(유나 定+페드루 判, #4106) — 패널의 shrink-0(절대 안 줄어듦)을
// 걷고 min-h-0(양보하는 쪽)으로 뒤집었다 — 토스트 1장은 항상 온전해야 하고, 그 대신
// 패널이 필요한 만큼 줄어든다(자기 스크롤이 있어 내용을 안 잃는다).
//
// story #3759 CHANGES 3차(유나 ⛔+페드루 判, #4106) — 「토스트 1장 항상 온전」을 애초에
// min-h-[5.5rem](88px) 수치 바닥으로 세웠는데, 배포 CSS 실측(제목만 58·짧은 본문 74·
// 두 줄 본문 90px)에서 90>88이라 최신이 2px 잘렸다 — 회피 상수를 없앤 스토리에 새 회피
// 상수가 다시 들어온 모순(캡처 픽스처가 한 줄이라 못 걸렸던 축). 처방을 구조로 바꿨다:
// 최신 한 장만 shrink-0 래퍼로 분리(수치 비교 없이 무조건 안 줄어듦), 나머지는 별도
// min-h-0 overflow-hidden 서브스택.
describe('BottomDock 높이 예산(story #3759 CHANGES, #4106) — 패널 top ≥ 0 + 토스트 1장 항상 온전 회귀가드', () => {
  it('bottom-dock.tsx 컬럼이 max-h 예산과 min-h-0을 갖는다(예산 없이 무한정 자라지 않는다)', () => {
    const content = read('src/components/nav/bottom-dock.tsx');
    expect(content).toContain('max-h-[calc(100vh-var(--bottom-dock-inset)-2rem)]');
    expect(content).toContain('min-h-0');
  });

  it('support-widget-launcher.tsx 패널이 min-h-0 + max-h-(고정 h- 아님)다(양보하는 쪽)', () => {
    const content = read('src/components/support-widget/support-widget-launcher.tsx');
    expect(content).toContain('max-h-[min(480px,calc(100vh-var(--bottom-dock-inset)-6rem))] w-[360px] max-w-[calc(100vw-2.5rem)] min-h-0 flex-col');
    // 옛 고정 h-[...] 리터럴이 되돌아오면(패널이 다시 "고정" 높이를 고집하면) 잡는다.
    // (\b는 "max-h"의 "-h" 앞에서도 걸려 오탐하므로, 따옴표/공백 뒤에 바로 오는 단독
    // "h-[min(..." 토큰인지를 직접 요구한다 — "max-h-["는 그 앞이 "x-"라 안 걸린다.)
    expect(content).not.toMatch(/(?:"|\s)h-\[min\(480px,calc\(100vh-var\(--bottom-dock-inset\)-6rem\)\)\]/);
    // 패널 className에 shrink-0이 되돌아오면(다시 "절대 안 줄어듦"이 되면) 토스트가 조각난다
    // — panel의 className 문자열 자체(패널 div 한 줄)에 shrink-0이 없는지 직접 검사한다
    // (파일 전체엔 런처 버튼 자신의 shrink-0이 별도로 있어 파일 전체 not.toContain은 오탐).
    const panelClassNameLine = content.split('\n').find((l) => l.includes('role="dialog"') === false && l.includes('max-h-[min(480px,calc(100vh-var(--bottom-dock-inset)-6rem))]'));
    expect(panelClassNameLine).toBeDefined();
    expect(panelClassNameLine).not.toContain('shrink-0');
  });

  it('toast.tsx ToastContainer가 최신 토스트를 shrink-0 래퍼로 분리한다(수치 바닥 아님 — 되돌리기 잘림 회귀가드)', () => {
    const content = read('src/components/ui/toast.tsx');
    expect(content).toContain('<div className="shrink-0">');
    // story #3759 CHANGES 3차의 핵심 회귀가드 — min-h-[5.5rem] 같은 픽셀/rem 수치 바닥이
    // 코드(주석 제외)에 다시 들어오면 실패한다(수치는 콘텐츠에 따라 항상 깨질 수 있다 —
    // 구조만이 안전). 주석은 이 회귀 자체를 설명하려 그 리터럴을 그대로 인용하므로 코드
    // 줄만 걸러 검사한다(stripCommentLines).
    const codeOnly = stripCommentLines(content);
    expect(codeOnly).not.toMatch(/min-h-\[[\d.]+rem\]/);
    expect(codeOnly).not.toMatch(/min-h-\[[\d.]+px\]/);
  });

  it('toast.tsx ToastContainer가 오래된 토스트를 별도 min-h-0 overflow-hidden 서브스택으로 둔다(넘치면 그쪽만 자름)', () => {
    const content = read('src/components/ui/toast.tsx');
    expect(content).toContain('flex min-h-0 flex-col-reverse gap-2 overflow-hidden');
  });

  it('toast.tsx ToastContainer가 최신=toasts 마지막·오래된=나머지 뒤집은 순으로 분리한다(구조 자체가 우선순위를 담음)', () => {
    const content = read('src/components/ui/toast.tsx');
    expect(content).toMatch(/toasts\[toasts\.length\s*-\s*1\]/);
    expect(content).toMatch(/toasts\.slice\(0,\s*-1\)/);
    expect(content).toMatch(/\[\.\.\.older\]\.reverse\(\)/);
  });
});

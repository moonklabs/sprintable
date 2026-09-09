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

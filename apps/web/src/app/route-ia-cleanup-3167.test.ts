// story #3167(IA 정리·통 A) — 죽은 라우트 스텁 6(+고아 형제 error/loading 3) 폐기·
// redirect-only 3 판정 고정. Next.js App Router는 `app/` 트리 자체가 라우팅 표를 겸하므로
// (page.tsx 부재 = 그 경로 404), 파일 존재 여부 검증이 곧 "그 주소가 실제로 죽었는가/살아
// 있는가"를 직접 증명한다 — 옛 주소를 실제로 방문하는 e2e 없이도 이게 정직한 pin이다.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const APP_DIR = join(__dirname); // apps/web/src/app

describe('story #3167 AC1/AC3 — 죽은 notFound 스텁 6 + 고아 형제 3 폐기(제거 라우트=404)', () => {
  const removed = [
    '(authenticated)/meetings/page.tsx',
    '(authenticated)/meetings/error.tsx',
    '(authenticated)/meetings/loading.tsx',
    '(authenticated)/meetings/new/page.tsx',
    '(authenticated)/meetings/[id]/page.tsx',
    '(authenticated)/meetings/[id]/error.tsx',
    '(authenticated)/meetings/[id]/loading.tsx',
    '(authenticated)/organization/workforce/deploy/page.tsx',
    '(authenticated)/organization/workforce/personas/new/page.tsx',
    '(authenticated)/organization/workforce/workflow/page.tsx',
  ];

  for (const rel of removed) {
    it(`${rel} — 파일이 존재하지 않는다(=이 경로는 App Router에서 404)`, () => {
      expect(existsSync(join(APP_DIR, rel))).toBe(false);
    });
  }

  it('personas/ 디렉토리 자체도 통째로 비었다(new/만 있던 자리 — dangling 빈 폴더 확認)', () => {
    expect(existsSync(join(APP_DIR, '(authenticated)/organization/workforce/personas'))).toBe(false);
  });
});

describe('story #3167 AC2 — redirect-only 3건은 실링크 확認 결과 전부 유지(고아 아님)', () => {
  it('workforce/recruiter — command-palette-actions.ts가 지금도 targetRoute로 실사용(라이브 내부 링크)', () => {
    const content = readFileSync(join(APP_DIR, '(authenticated)/organization/workforce/recruiter/page.tsx'), 'utf-8');
    expect(content).toContain("redirect('/organization/workforce?tab=recruit')");
    const paletteActions = readFileSync(
      join(APP_DIR, '../components/command-palette/command-palette-actions.ts'), 'utf-8',
    );
    expect(paletteActions).toContain("targetRoute: '/organization/workforce/recruiter'");
  });

  it('dashboard/settings — upgrade-modal.tsx CTA가 지금도 href로 실사용(라이브 내부 링크)', () => {
    const content = readFileSync(join(APP_DIR, 'dashboard/settings/page.tsx'), 'utf-8');
    expect(content).toContain("redirect('/settings')");
    const upgradeModal = readFileSync(join(APP_DIR, '../components/ui/upgrade-modal.tsx'), 'utf-8');
    expect(upgradeModal).toContain('href="/dashboard/settings"');
  });

  it('workforce/hitl — 이 리포 안에서 외부 실링크(북마크/메일) 존재를 반증도 확定도 못 한다 → 통 A 규율(dashboard/page.tsx #3179 선례)대로 유지', () => {
    const content = readFileSync(join(APP_DIR, '(authenticated)/organization/workforce/hitl/page.tsx'), 'utf-8');
    expect(content).toContain("redirect('/inbox')");
  });
});

describe('story #3167 AC4 — [ws]/[proj]/* notFound는 이 스토리 대상 아님(정당 가드, 미접촉)', () => {
  it('flow 리소스 부재 가드가 여전히 존재한다(스토리가 안 건드렸음을 소극 증명)', () => {
    // [ws]/[proj]/* 하위는 리소스 존재 여부에 따른 조건부 notFound()이지, 이 스토리가 다루는
    // "기능 자체가 죽은" 무조건 notFound() 스텁이 아니다 — 혼동 금지 조항(AC4) 그대로 미접촉.
    expect(existsSync(join(APP_DIR, '(authenticated)/[ws]/[proj]'))).toBe(true);
  });
});

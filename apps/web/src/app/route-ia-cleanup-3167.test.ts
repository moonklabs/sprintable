// story #3167(IA 정리·통 A) — 죽은 라우트 스텁 6(+고아 형제 error/loading 3) 폐기·
// redirect-only 3 판정 고정. Next.js App Router는 `app/` 트리 자체가 라우팅 표를 겸하므로
// (page.tsx 부재 = 그 경로 404), 파일 존재 여부 검증이 곧 "그 주소가 실제로 죽었는가/살아
// 있는가"를 직접 증명한다 — 옛 주소를 실제로 방문하는 e2e 없이도 이게 정직한 pin이다.
//
// story #3915(2026-09-15) — AC2 「redirect-only 3건은 실링크 확認 결과 전부 유지」의
// 판별 방식이 바뀌었다: workforce/recruiter·workforce/hitl·settings/members/agents/[id]
// 셋 다 page.tsx 안에서 next/navigation의 redirect()를 직접 불렀는데, 셋 다 조상
// 디렉토리에 loading.tsx(스트리밍 Suspense 경계)가 있어 그 redirect()가 React 렌더
// 단계까지 밀려 들어갔다 — 응답 헤더가 200으로 커밋된 뒤 redirect()가 실행되면 Next가
// 깨끗한 3xx를 못 내고 "server rendering errored→client 전환" 열화 경로(meta refresh)를
// 타는데, 그 경로가 Next.js 자체 내부 싱글턴 Router의 훅 호출 수를 렌더마다 다르게 만들어
// React 오류 코드 310을 던졌다(curl 실측: 셋 다 200+메타리프레시). 처방=이 세 주소를
// next.config.ts의 라우팅 단계 redirects()로 옮겨 React 렌더 진입 자체를 없앤다 — 그러면
// 「파일 존재=주소 생존」 자가 더 이상 이 세 개엔 안 맞는다(파일이 없어도 주소는 산다,
// next.config redirects 항목이 그 자리를 대신 진다). 이 파일의 AC2 블록만 「next.config
// redirects 항목 존재(source→destination·permanent)」자로 갱신 — 항목 하나 지우면 RED.
// AC1/AC3/AC4(죽은 스텁 폐기·[ws]/[proj] 미접촉)는 그대로 파일-존재 자를 쓴다(그 라우트들은
// loading.tsx 경계 문제와 무관 — 이 스토리가 건드리는 것은 AC2의 세 주소뿐).
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

const APP_DIR = join(__dirname); // apps/web/src/app

async function resolvedRedirects(): Promise<Array<{ source: string; destination: string; permanent: boolean }>> {
  const config = nextConfig as unknown as {
    redirects?: () => Promise<Array<{ source: string; destination: string; permanent: boolean }>>;
  };
  return config.redirects!();
}

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

describe('story #3167 AC2 — redirect-only 은퇴 주소는 실링크 확認 결과 전부 유지(고아 아님)', () => {
  it('dashboard/settings — upgrade-modal.tsx CTA가 지금도 href로 실사용(라이브 내부 링크) — page.tsx 안 redirect() 유지(조상에 loading.tsx 없어 story #3915 대상 밖)', () => {
    const content = readFileSync(join(APP_DIR, 'dashboard/settings/page.tsx'), 'utf-8');
    expect(content).toContain("redirect('/settings')");
    const upgradeModal = readFileSync(join(APP_DIR, '../components/ui/upgrade-modal.tsx'), 'utf-8');
    expect(upgradeModal).toContain('href="/dashboard/settings"');
  });
});

// story #3915 — workforce/recruiter·workforce/hitl·settings/members/agents/[id] 세
// 은퇴 주소는 loading.tsx 경계 아래서 page.tsx 안 redirect()를 부르던 것이 React 오류
// 코드 310의 근본원인이라 next.config.ts의 라우팅 단계 redirects()로 옮겼다(위 파일 헤더
// 설명 참고) — page.tsx 자체는 삭제, 이 자리서 라우팅 설정을 직접 pin한다.
describe('story #3915 — loading.tsx 경계 아래 은퇴 주소 3건은 next.config redirects로 이관(React #310 회귀가드)', () => {
  it('workforce/recruiter — page.tsx가 더 이상 존재하지 않는다(주소는 next.config redirects가 대신 진다)', () => {
    expect(existsSync(join(APP_DIR, '(authenticated)/organization/workforce/recruiter/page.tsx'))).toBe(false);
  });

  it('workforce/hitl — page.tsx·디렉토리 자체가 사라졌다(dangling 빈 폴더 없음)', () => {
    expect(existsSync(join(APP_DIR, '(authenticated)/organization/workforce/hitl'))).toBe(false);
  });

  it('settings/members/agents/[id] — page.tsx·디렉토리 자체가 사라졌다(dangling 빈 폴더 없음)', () => {
    expect(existsSync(join(APP_DIR, '(authenticated)/settings/members/agents/[id]'))).toBe(false);
  });

  it('next.config redirects()에 세 항목이 정확한 source·destination·permanent로 등재됐다', async () => {
    const redirects = await resolvedRedirects();
    expect(redirects).toContainEqual({
      source: '/organization/workforce/recruiter',
      destination: '/organization/workforce?tab=recruit',
      permanent: true,
    });
    expect(redirects).toContainEqual({
      source: '/organization/workforce/hitl',
      destination: '/inbox',
      permanent: true,
    });
    expect(redirects).toContainEqual({
      source: '/settings/members/agents/:id',
      destination: '/organization/workforce/:id',
      permanent: true,
    });
  });

  // workforce/hitl — 이 리포 안에서 외부 실링크(북마크/메일) 존재를 반증도 확定도 못 한다
  // → 통 A 규율(dashboard/page.tsx #3179 선례)대로 유지(주소만 next.config로 이관, 폐기
  // 아님) — 그 결정 자체는 위 count-lock 테스트('/organization/workforce/hitl' 항목
  // 존재)가 실행 가능한 형태로 이미 고정한다.
  it('workforce/recruiter — command-palette-actions.ts가 지금도 targetRoute로 실사용(라이브 내부 링크, next.config redirects가 받아준다)', () => {
    const paletteActions = readFileSync(
      join(APP_DIR, '../components/command-palette/command-palette-actions.ts'), 'utf-8',
    );
    // story #4231 3차 — 목적지는 프로젝트를 싣는 함수(withProject)를 거친다.
    expect(paletteActions).toContain("targetRoute: withProject('/organization/workforce/recruiter')");
  });
});

describe('story #3167 AC4 — [ws]/[proj]/* notFound는 이 스토리 대상 아님(정당 가드, 미접촉)', () => {
  it('flow 리소스 부재 가드가 여전히 존재한다(스토리가 안 건드렸음을 소극 증명)', () => {
    // [ws]/[proj]/* 하위는 리소스 존재 여부에 따른 조건부 notFound()이지, 이 스토리가 다루는
    // "기능 자체가 죽은" 무조건 notFound() 스텁이 아니다 — 혼동 금지 조항(AC4) 그대로 미접촉.
    expect(existsSync(join(APP_DIR, '(authenticated)/[ws]/[proj]'))).toBe(true);
  });
});

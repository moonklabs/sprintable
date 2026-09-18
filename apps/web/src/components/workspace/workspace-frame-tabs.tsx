'use client';

import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

const TABS = [
  // story #3844(UX-v3·FE 4·일감 1, PO 지적 2026-09-14 07:32Z — 시안 06d2d61c 재대조: 탭
  // 순서는 「목록·보드·타임라인·스프린트·회고」, 목록이 첫 탭·기본 보기). 「타임라인」은 이
  // 카드 스코프 밖(별 라우트·데이터 0 — 지어내지 않는다, 별 카드 필요). 처음엔 06:28Z
  // 지시대로 배열 끝에 얹었다가 이 재대조로 앞으로 옮겼다.
  { key: 'workList', path: 'work-list' },
  { key: 'board', path: 'flow' },
  { key: 'sprints', path: 'sprints' },
  { key: 'epic', path: 'epics' },
  // story #3845(UX-v3·FE 5·일감 2, 페드루 PO 確定 §③ⓑ 2026-09-14) — 「일감」 흡수 지도
  // (doc a699be00 §②)의 「회고」 탭. board/sprints/epic과 동형(실 라우트 /retro 보존,
  // 이 프레임은 그 위에 얹힌 얕은 nav일 뿐 — WorkspaceFrameTabs 파일 상단 주석 참고).
  // labelKey 'retro'는 nav-config.ts::LEGACY_NAV_ITEMS가 이미 쓰던 값 재사용(사본 0).
  { key: 'retro', path: 'retro' },
] as const;

type WorkspaceFrameTabKey = (typeof TABS)[number]['key'];

// story #3844(PO 지적 2026-09-14 07:53Z, 캡처 3 라이브 눈확認로 발견) — app-sidebar.tsx의
// 「일감」 1차 메뉴(id 'board')가 resourceLink('flow') 단일 경로만 활성 판정해 /work-list·
// /sprints·/epics·/retro(이 프레임이 얹힌 나머지 탭)에선 사이드바가 비활성으로 떨어졌다.
// 이 배열이 SSOT — 탭을 하나 늘리면 사이드바 활성 판정도 하드코딩 없이 자동으로 늘어난다
// (app-sidebar.tsx가 TABS를 직접 import하지 않는 건 'use client' 순환 없이 얇은 경로
// 목록만 필요해서 — 경로 문자열만 뽑아 재수출한다).
export const WORKSPACE_FRAME_TAB_PATHS: readonly string[] = TABS.map((tab) => tab.path);

/**
 * story #2930(P0-G) I3(doc ia-4zone-redesign-2930, PO 스코프 확定 ①=ⓒ 2026-08-22) — nav에서
 * flow+sprints가 「보드」 단일 1차 메뉴로 접히면서(nav-config.ts work 존) 사라진 sprints
 * 진입점을 메우는 얕은 프레임. 두 라우트(/flow·/sprints)는 그대로 실 페이지로 남기고(라우트
 * 보존 원칙, path 불변) 이 컴포넌트가 그 위에 얹혀 «워크스페이스 뷰 전환처럼 보이는» 탭 한
 * 줄만 그린다 — 실제로는 진짜 페이지 네비게이션(router.push)이라 각 페이지의 자체 로직·
 * 데이터 페칭은 서로 안 건드린다. flow-client.tsx 자체의 기존 3탭(가설/갈래/칸반, E-FLOW-V4
 * 기 확定)과는 다른 층이라 그건 그대로 둔다 — 이 프레임은 그 위(바깥)에 얹힌다.
 *
 * story #2931(2930-I3 분리, 유나 (a) 시안 확定) — "에픽"(시안 3뷰 중 하나)이 그때는 코드상
 * 단독 표면이 없어(analytics API만 존재) 스코프 밖이었으나, 이제 에픽 스윔레인
 * (epic-swimlane-board.tsx, /epics)으로 실체가 생겨 3번째 탭으로 합류한다.
 */
export function WorkspaceFrameTabs({ active }: { active: WorkspaceFrameTabKey }) {
  const t = useTranslations('nav');
  const router = useRouter();
  const params = useParams<{ ws: string; proj: string }>();
  // story #3043(PO+유나 IA 확定 ⓐ, 2026-08-25) — "「지금」 탭을 열 때 여기가 보드인 것이
  // 즉시 읽히게" 시각 위계 승격. PR#3358(유나 QA)이 세운 「상위 프레임=underline·내부 뷰
  // 탭=rounded pill」구분 자체는 유효한 규율이라 유지(pill로 갈아타지 않음 — 재규격이 아니라
  // <lg에서만 이 underline 계열 안에서 텍스트·인디케이터 두께를 키운다).
  const isMobile = useIsMobile();

  return (
    // 유나 QA 블로커(PR#3358, 2026-08-22) — flow-client 내부 3탭(가설/갈래/칸반)과 스타일이
    // byte-identical(둘 다 rounded pill+bg-muted active)이라 스택되면 «동일 탭 행 2개」로
    // 위계 구분이 안 됐다. 처방(유나 확定): 상위 프레임은 text-sm+하단 인디케이터(underline)로
    // — 페이지-크롬(notification-bell.tsx 필터 탭과 동형 패턴, 신규 발명 아님). 내부 뷰 탭의
    // rounded pill과 kind 자체가 달라 한눈에 "이건 다른 층"으로 읽힌다.
    <div className="flex items-center gap-4 border-b border-border" role="tablist" aria-label={t('workspace')}>
      {TABS.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          onClick={() => router.push(`/${params.ws}/${params.proj}/${tab.path}`)}
          className={cn(
            'font-semibold transition',
            isMobile
              ? `-mb-px border-b-[3px] px-1 pb-2.5 text-base ${active === tab.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`
              : `-mb-px border-b-2 px-1 pb-2 text-sm ${active === tab.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`,
          )}
        >
          {t(tab.key)}
        </button>
      ))}
    </div>
  );
}

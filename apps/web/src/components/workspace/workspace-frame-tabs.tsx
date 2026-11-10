'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { whenFirstScreenQuiet } from '@/lib/first-screen-quiet';
import { TabNav, TabNavLink } from '@/components/ds/tab-nav';

const TABS = [
  // story #3844(UX-v3·FE 4·일감 1, PO 지적 2026-09-14 07:32Z — 시안 06d2d61c 재대조: 탭
  // 순서는 「목록·보드·타임라인·스프린트·회고」, 목록이 첫 탭·기본 보기). 「타임라인」은 이
  // 카드 스코프 밖(별 라우트·데이터 0 — 지어내지 않는다, 별 카드 필요). 처음엔 06:28Z
  // 지시대로 배열 끝에 얹었다가 이 재대조로 앞으로 옮겼다.
  { key: 'workList', labelKey: 'workList', path: 'work-list' },
  // story #4278 — 라벨은 labelKey로 읽는다(key와 같은 값). t(tab.key)만으론 죽은 키 가드가 nav.board 소비를 못 봤다(예전엔 «전체» 메뉴
  // 머리 문장의 t('board')가 대신 세어 줬는데 그 문장이 탭 이름만 쓰게 바뀌었다).
  { key: 'board', labelKey: 'board', path: 'flow' },
  { key: 'sprints', labelKey: 'sprints', path: 'sprints' },
  { key: 'epic', labelKey: 'epic', path: 'epics' },
  // story #3845(UX-v3·FE 5·일감 2, 페드루 PO 確定 §③ⓑ 2026-09-14) — 「일감」 흡수 지도
  // (doc a699be00 §②)의 「회고」 탭. board/sprints/epic과 동형(실 라우트 /retro 보존,
  // 이 프레임은 그 위에 얹힌 얕은 nav일 뿐 — WorkspaceFrameTabs 파일 상단 주석 참고).
  // labelKey 'retro'는 nav-config.ts::LEGACY_NAV_ITEMS가 이미 쓰던 값 재사용(사본 0).
  { key: 'retro', labelKey: 'retro', path: 'retro' },
  // story #3989(「일감」 흡수 3/N, PO 확定 — worklist-6item-absorption doc §②-1) — 전수
  // 가설 집. 다른 탭과 동형(실 라우트 /hypotheses 보존, 이 프레임은 얕은 nav일 뿐).
  // labelKey 'hypothesis'는 flow.ladderName_earth와 같은 낱말(「가설」)이라 값만 맞추고
  // 키는 새로 둔다(namespace가 다름 — 사본이 아니라 같은 사실·다른 화면).
  { key: 'hypothesis', labelKey: 'hypothesis', path: 'hypotheses' },
] as const;

export type WorkspaceFrameTabKey = (typeof TABS)[number]['key'];

// story #3844(PO 지적 2026-09-14 07:53Z, 캡처 3 라이브 눈확認로 발견) — app-sidebar.tsx의
// 「일감」 1차 메뉴(id 'board')가 resourceLink('flow') 단일 경로만 활성 판정해 /work-list·
// /sprints·/epics·/retro(이 프레임이 얹힌 나머지 탭)에선 사이드바가 비활성으로 떨어졌다.
// 이 배열이 SSOT — 탭을 하나 늘리면 사이드바 활성 판정도 하드코딩 없이 자동으로 늘어난다
// (app-sidebar.tsx가 TABS를 직접 import하지 않는 건 'use client' 순환 없이 얇은 경로
// 목록만 필요해서 — 경로 문자열만 뽑아 재수출한다).
export const WORKSPACE_FRAME_TAB_PATHS: readonly string[] = TABS.map((tab) => tab.path);
// story #4274 — 여섯 경로의 loading.tsx가 탭 줄을 품는지 가드가 키 · 경로 짝으로 대조한다(loading-coverage.guard.test.ts).
export const WORKSPACE_FRAME_TABS: ReadonlyArray<{ key: WorkspaceFrameTabKey; path: string }> = TABS;

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
  const params = useParams<{ ws: string; proj: string }>();
  const router = useRouter();
  const hrefOf = (path: string) => `/${params.ws}/${params.proj}/${path}`;
  // [SID:4299] 탭 프리패치는 첫 화면 뒤로 — 기본 prefetch Link 여섯은 보이자마자 경로마다 tree + data 둘씩 나가, 기기 콜드에서 물결 뒤 정착을
  // +300ms 밀고 서버 RSC 렌더를 콜드마다 +11 늘렸다(AC3 판 2026-09-28). 4291의 뜻(형제 탭 전환 무반응 없앰)은 지킨다:
  // 첫 화면이 조용해지면 지금 탭 이웃 둘만 미리 받고, 나머지는 누르려는 기색(pointerenter · focus · touchstart) 때 받는다.
  const activeIndex = TABS.findIndex((tab) => tab.key === active);
  useEffect(() => {
    if (activeIndex < 0) return;
    const neighbors = [TABS[activeIndex - 1], TABS[activeIndex + 1]].filter((tab) => tab !== undefined);
    return whenFirstScreenQuiet(() => { for (const tab of neighbors) router.prefetch(hrefOf(tab.path)); });
    // router · hrefOf는 매 렌더 새 참조 — 지금 탭 · 주소 조각이 바뀔 때만 다시 건다.
  }, [activeIndex, params.ws, params.proj]); // eslint-disable-line react-hooks/exhaustive-deps
  // story #3043(PO+유나 IA 확定 ⓐ, 2026-08-25) — "「지금」 탭을 열 때 여기가 보드인 것이
  // 즉시 읽히게" 시각 위계 승격. PR#3358(유나 QA)이 세운 「상위 프레임=underline·내부 뷰
  // 탭=rounded pill」구분 자체는 유효한 규율이라 유지(pill로 갈아타지 않음 — 재규격이 아니라
  // <lg에서만 이 underline 계열 안에서 텍스트·인디케이터 두께를 키운다).

  return (
    // story #4888(UI-5 보드 · 목록 화면, PO 11-10 — 유나 5545 TabNav가 develop에 들어온 뒤) — 이 줄은 링크로 다른 화면(주소)에 가는 줄이다.
    // 예전엔 링크에 role=tab / aria-selected를 얹고 줄에 role=tablist를 걸었지만 탭 패널이 없는 줄이 «탭 패널을 가진 척»하는 꼴이었다.
    // 이제 ds `TabNav`(nav 랜드마크) + 켜진 링크의 aria-current="page". 모양(밑줄 · 굵기 · 폰 누름 영역 44 · 가로 스크롤 + 오른쪽 흐림 · 켜진 탭 화면 안으로)은
    // TabNav가 쥔다(story #4277 · #4222의 뜻 그대로 — 서버 출력이 곧 최종 높이).
    // [SID:4299] 탭 = 프리패치되는 <Link>가 아니라 «보일 때 자동 프리패치 끈» <Link>(prefetch={false}) + 위 훅(이웃 둘 · 첫 화면 뒤) + 누르려는 기색 때 router.prefetch.
    // 탭 줄은 `[ws]/[proj]` 레이아웃(WorkTabsFrame)에 살아 전환 때 다시 그려지지 않는다 — story #4291.
    <TabNav aria-label={t('workspace')} data-testid="workspace-frame-tabs">
      {TABS.map((tab) => (
        <TabNavLink key={tab.key} asChild active={active === tab.key}>
          <Link
            href={hrefOf(tab.path)}
            prefetch={false}
            onPointerEnter={() => router.prefetch(hrefOf(tab.path))}
            onFocus={() => router.prefetch(hrefOf(tab.path))}
            onTouchStart={() => router.prefetch(hrefOf(tab.path))}
          >
            {t(tab.labelKey)}
          </Link>
        </TabNavLink>
      ))}
    </TabNav>
  );
}

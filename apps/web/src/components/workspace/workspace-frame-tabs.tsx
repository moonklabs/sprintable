'use client';

import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

const TABS = [
  { key: 'board', path: 'flow' },
  { key: 'sprints', path: 'sprints' },
] as const;

type WorkspaceFrameTabKey = (typeof TABS)[number]['key'];

/**
 * story #2930(P0-G) I3(doc ia-4zone-redesign-2930, PO 스코프 확定 ①=ⓒ 2026-08-22) — nav에서
 * flow+sprints가 「보드」 단일 1차 메뉴로 접히면서(nav-config.ts work 존) 사라진 sprints
 * 진입점을 메우는 얕은 프레임. 두 라우트(/flow·/sprints)는 그대로 실 페이지로 남기고(라우트
 * 보존 원칙, path 불변) 이 컴포넌트가 그 위에 얹혀 «워크스페이스 뷰 전환처럼 보이는» 탭 한
 * 줄만 그린다 — 실제로는 진짜 페이지 네비게이션(router.push)이라 각 페이지의 자체 로직·
 * 데이터 페칭은 서로 안 건드린다. flow-client.tsx 자체의 기존 3탭(가설/갈래/칸반, E-FLOW-V4
 * 기 확定)과는 다른 층이라 그건 그대로 둔다 — 이 프레임은 그 위(바깥)에 얹힌다.
 *
 * "에픽"(시안 3뷰 중 하나)은 코드상 단독 표면이 없어(analytics API만 존재) 이 슬라이스
 * 스코프 밖(PO 확定, 신규 페이지 제작은 후속 스토리) — 그래서 TABS가 2개뿐이다.
 */
export function WorkspaceFrameTabs({ active }: { active: WorkspaceFrameTabKey }) {
  const t = useTranslations('nav');
  const router = useRouter();
  const params = useParams<{ ws: string; proj: string }>();

  return (
    <div className="flex items-center gap-1 border-b border-border pb-2" role="tablist" aria-label={t('workspace')}>
      {TABS.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          onClick={() => router.push(`/${params.ws}/${params.proj}/${tab.path}`)}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${active === tab.key ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          {t(tab.key)}
        </button>
      ))}
    </div>
  );
}

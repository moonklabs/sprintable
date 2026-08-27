'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { MOBILE_HUB_EXCLUDE_IDS, MOBILE_HUB_GROUP_ORDER, NAV_GROUPS } from '@/lib/nav-config';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { ProfileMenu } from '@/components/nav/profile-menu';

// story #2682(모바일 IA S2, doc mobile-ia-full-completion-2678 §2.3) — 임시 평면 stub(#1958·
// #1965)을 데스크톱 GNB(app-sidebar.tsx) 5 zones를 그대로 미러하는 그룹형 허브로 재건한다.
// 목적지 목록 자체는 새로 만들지 않는다 — S1이 추출한 NAV_GROUPS(nav-config.ts)를 그대로
// 소비해 데스크톱과 drift 없이 항상 정합한다(SSOT). 그룹 순서·제외 목록도 story #2684(S4)에서
// nav-config.ts로 옮겨 depth 가드가 이 페이지 내부를 몰라도 SSOT 하나만 보고 판정할 수 있다.
export default function MorePage() {
  const t = useTranslations('nav');
  const tMore = useTranslations('mobileTabBar');
  const { userName } = useDashboardContext();

  const hubGroups = MOBILE_HUB_GROUP_ORDER
    .map((groupId) => NAV_GROUPS.find((g) => g.id === groupId))
    .filter((g): g is NonNullable<typeof g> => !!g)
    .map((g) => ({ ...g, items: g.items.filter((item) => !MOBILE_HUB_EXCLUDE_IDS.has(item.id)) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      {/* 근본 재구현(2076 회귀 후속, 유나양 규격) — 이 4탭 루트는 TopBarSlot을 아예 안 써서
          allowlist(showContextChip)로 켤 자리가 없었다. "슬롯 없으면 자동 켬"은 fail-open이라
          금지(유나양) — 슬롯을 명시적으로 쓰게 해서 켠다. */}
      <TopBarSlot title={<h1 className="text-sm font-medium">{tMore('more')}</h1>} showContextChip />
      {/* story #3146(선생님 실사용 발견) — 계정 스위치(ProfileMenu, 데스크톱 AppSidebar
          전용 마운트)가 모바일 표면 어디에도 진입점이 없어 "로그아웃 외엔 계정을 바꿀 방법이
          없다"였다. NAV_GROUPS(페이지 목적지 SSOT) 항목이 아니라 데스크톱과 동일하게 계정
          자체의 액션이라 그 목록 밖, 최상단 전용 자리에 둔다(데스크톱 사이드바 하단 배치와
          같은 급). 컴포넌트는 완전 재사용(신규 UI 0) — triggerClassName만 이 밝은 배경에
          맞게 오버라이드. */}
      {userName ? (
        <div className="mb-4 rounded-xl border border-border">
          <ProfileMenu
            name={userName}
            triggerClassName="flex min-h-12 w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition hover:bg-muted"
          />
        </div>
      ) : null}
      {/* story #2682 AC3 — 임시 stub 배너(#1965) 제거. 섹션 헤더 있는 단일 스크롤 목록(아코디언
          아님 — 아코디언은 목적지를 탭 뒤에 숨겨 depth+1이 된다, doc §2.3). */}
      <div className="space-y-5">
        {hubGroups.map((group) => (
          <section key={group.id}>
            <h2 className="mb-1.5 px-1 text-xs font-semibold text-muted-foreground">
              {group.id === 'settings' ? t('settings') : t(group.labelKey!)}
            </h2>
            <ul className="divide-y divide-border rounded-xl border border-border">
              {group.items.map((item) => {
                const href = item.kind === 'static' ? item.path : `/${item.path}`;
                const Icon = item.icon;
                return (
                  <li key={item.id}>
                    <Link
                      href={href}
                      className="flex min-h-12 items-center gap-3 px-4 py-3 text-sm text-foreground hover:bg-muted"
                    >
                      <Icon className="size-[18px] shrink-0 text-muted-foreground" strokeWidth={1.8} />
                      {t(item.labelKey)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

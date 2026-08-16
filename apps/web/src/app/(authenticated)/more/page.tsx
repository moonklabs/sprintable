'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { NAV_GROUPS } from '@/lib/nav-config';

// story #2682(모바일 IA S2, doc mobile-ia-full-completion-2678 §2.3) — 임시 평면 stub(#1958·
// #1965)을 데스크톱 GNB(app-sidebar.tsx) 5 zones를 그대로 미러하는 그룹형 허브로 재건한다.
// 목적지 목록 자체는 새로 만들지 않는다 — S1이 추출한 NAV_GROUPS(nav-config.ts)를 그대로
// 소비해 데스크톱과 drift 없이 항상 정합한다(SSOT).
//
// 그룹 순서는 데스크톱과 다르다(doc §2.3 명시) — 데스크톱은 "조직이 4구역 위 프레임"이라
// 맨 위지만, 모바일 허브는 §2.2 분류(자주→가끔→관리) 순서를 따라 조직·설정(관리)이 뒤로
// 간다: 홈·지금 / 작업 / 신뢰 / 지식 / 조직(이벤트 포함) / 설정.
const MOBILE_GROUP_ORDER = ['now', 'work', 'trust', 'knowledge', 'organization', 'settings'];

// flow·inbox·chats는 바텀 탭(지금/결재/채팅)이 이미 depth 1로 커버한다(doc §2.2 "자주" 축) —
// 허브에 또 실으면 같은 목적지로 가는 진입점이 두 개가 되고 "몇 탭"의 의미가 흐려진다
// (기존 stub도 board를 같은 이유로 뺐던 것과 같은 원칙, page.tsx 옛 주석 참조).
const HUB_EXCLUDE_ITEM_IDS = new Set(['flow', 'inbox', 'chats']);

export default function MorePage() {
  const t = useTranslations('nav');
  const tMore = useTranslations('mobileTabBar');

  const hubGroups = MOBILE_GROUP_ORDER
    .map((groupId) => NAV_GROUPS.find((g) => g.id === groupId))
    .filter((g): g is NonNullable<typeof g> => !!g)
    .map((g) => ({ ...g, items: g.items.filter((item) => !HUB_EXCLUDE_ITEM_IDS.has(item.id)) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      {/* 근본 재구현(2076 회귀 후속, 유나양 규격) — 이 4탭 루트는 TopBarSlot을 아예 안 써서
          allowlist(showContextChip)로 켤 자리가 없었다. "슬롯 없으면 자동 켬"은 fail-open이라
          금지(유나양) — 슬롯을 명시적으로 쓰게 해서 켠다. */}
      <TopBarSlot title={<h1 className="text-sm font-medium">{tMore('more')}</h1>} showContextChip />
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

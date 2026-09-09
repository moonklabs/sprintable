'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Card, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useIsMobile } from '@/hooks/use-mobile';
import { MOBILE_HUB_EXCLUDE_IDS, MOBILE_HUB_GROUP_ORDER, NAV_GROUPS } from '@/lib/nav-config';

// story #2682(모바일 IA S2, doc mobile-ia-full-completion-2678 §2.3) — 임시 평면 stub(#1958·
// #1965)을 데스크톱 GNB(app-sidebar.tsx) 5 zones를 그대로 미러하는 그룹형 허브로 재건한다.
// 목적지 목록 자체는 새로 만들지 않는다 — S1이 추출한 NAV_GROUPS(nav-config.ts)를 그대로
// 소비해 데스크톱과 drift 없이 항상 정합한다(SSOT). 그룹 순서·제외 목록도 story #2684(S4)에서
// nav-config.ts로 옮겨 depth 가드가 이 페이지 내부를 몰라도 SSOT 하나만 보고 판정할 수 있다.
//
// story #fddd0e6b(IA ⑦ 전체 메뉴, 유나 시안 ⑦ 판b 036c983a) — 구역 카드(Card, 손코딩 ul
// 걷음) + 항목마다 「무엇이 여기 있나」 한 줄(NavItemConfig.descriptionKey, SSOT) + 화면
// 이름 찾기(원천은 이 페이지가 이미 만든 hubGroups — 팔레트와 별개 소비, 두 벌 아님) + 부제
// 수(「{n}개 화면 · {g}개 구역」)는 렌더 결과에서 센다(리터럴 금지 — MOBILE_HUB_EXCLUDE_IDS가
// 늘면 이 수도 따라 줄어야 한다).
export default function MorePage() {
  const t = useTranslations('nav');
  const tMore = useTranslations('mobileTabBar');
  const isMobile = useIsMobile();
  const [query, setQuery] = useState('');

  const hubGroups = useMemo(
    () =>
      MOBILE_HUB_GROUP_ORDER
        .map((groupId) => NAV_GROUPS.find((g) => g.id === groupId))
        .filter((g): g is NonNullable<typeof g> => !!g)
        .map((g) => ({ ...g, items: g.items.filter((item) => !MOBILE_HUB_EXCLUDE_IDS.has(item.id)) }))
        .filter((g) => g.items.length > 0),
    [],
  );

  const totalScreenCount = useMemo(() => hubGroups.reduce((sum, g) => sum + g.items.length, 0), [hubGroups]);
  const totalSectionCount = hubGroups.length;

  const normalizedQuery = query.trim().toLowerCase();
  // story #fddd0e6b(C) — 찾기는 이름·설명 둘 다 부분일치(대소문자 무시)로 거른다. 서버
  // 호출 0·상태는 로컬(이미 만든 hubGroups를 그 자리서 거를 뿐 — 원천 하나).
  const filteredGroups = useMemo(() => {
    if (!normalizedQuery) return hubGroups;
    return hubGroups
      .map((g) => ({
        ...g,
        items: g.items.filter((item) => {
          const label = t(item.labelKey).toLowerCase();
          const description = t(item.descriptionKey).toLowerCase();
          return label.includes(normalizedQuery) || description.includes(normalizedQuery);
        }),
      }))
      .filter((g) => g.items.length > 0);
  }, [hubGroups, normalizedQuery, t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      {/* 근본 재구현(2076 회귀 후속, 유나양 규격) — 이 4탭 루트는 TopBarSlot을 아예 안 써서
          allowlist(showContextChip)로 켤 자리가 없었다. "슬롯 없으면 자동 켬"은 fail-open이라
          금지(유나양) — 슬롯을 명시적으로 쓰게 해서 켠다.
          story #fddd0e6b(B) — 「전체」(mobileTabBar.more, 탭 이름)와 「전체 메뉴」(페이지
          제목, 새 키)는 다른 값이다 — 재사용 아님. */}
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('moreMenuTitle')}</h1>} showContextChip />
      <div className="mb-4 space-y-1">
        <p className="text-xs text-muted-foreground" data-testid="more-subtitle">
          {t('moreSubtitle', { n: totalScreenCount, g: totalSectionCount })}
        </p>
        {/* story #fddd0e6b(AC1②) — 탭 바가 실제로 있을 때만(useIsMobile() true) 이 문장을
            그린다. 데스크톱 폭에선 탭 바 자체가 없어 「아래 탭에 있다」가 거짓이 된다. */}
        {isMobile ? (
          <p className="text-xs text-muted-foreground" data-testid="more-tab-hint">
            {t('moreTabHint', {
              board: t('board'), inbox: t('inbox'), chats: t('chats'),
              now: tMore('now'), approvals: tMore('approvals'), chat: tMore('chat'),
            })}
          </p>
        ) : null}
      </div>
      <div className="relative mb-5">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('moreSearchPlaceholder')}
          aria-label={t('moreSearchPlaceholder')}
          className="pl-9"
          data-testid="more-search-input"
        />
      </div>
      {filteredGroups.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="more-search-empty">
          {t('moreSearchEmpty', { q: query.trim() })}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredGroups.map((group) => (
            <Card key={group.id} className="overflow-hidden">
              <CardHeader>
                <h2 className="text-sm font-semibold text-foreground">
                  {group.id === 'settings' ? t('settings') : t(group.labelKey!)}
                </h2>
              </CardHeader>
              <div className="divide-y divide-border">
                {group.items.map((item) => {
                  const href = item.kind === 'static' ? item.path : `/${item.path}`;
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.id}
                      href={href}
                      className="flex min-h-12 items-start gap-3 px-5 py-3 text-sm text-foreground hover:bg-muted sm:px-6"
                    >
                      <Icon className="mt-0.5 size-[18px] shrink-0 text-muted-foreground" strokeWidth={1.8} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{t(item.labelKey)}</span>
                        {/* 페드루 PO CHANGES①(2026-09-09, 캡처 리뷰) — 설명은 잘리면 정보가
                            조용히 버려진다(EN 긴 문안이 390px·sm 2열에서 「…」로 죽음). 제목
                            줄만 truncate, 설명은 줄바꿈 허용. */}
                        <span className="block text-xs text-muted-foreground">{t(item.descriptionKey)}</span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

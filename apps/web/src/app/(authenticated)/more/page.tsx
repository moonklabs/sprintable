'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Card, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { groupVisibleLegacyByTarget, LEGACY_NAV_ITEMS, MOBILE_HUB_GROUP_ORDER, resolveNavGroups } from '@/lib/nav-config';
import { buildMobileHubGroups, MOBILE_LEGACY_CARD_ID, sectionHeader } from '@/lib/mobile-hub-groups';
import { DEFAULT_NAV_V3_FLAGS, scopedResourceHref } from '@/lib/nav-v3-destinations';
import { tabDestinationNavIds, visibleTabLabels } from '@/components/nav/mobile-tab-bar';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { useFlatHref } from '@/hooks/use-flat-href';

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
  // story #4226 — flat(static) 목적지 링크는 `?p=`를 싣는다(use-flat-href).
  const flatHref = useFlatHref();
  const t = useTranslations('nav');
  const tMore = useTranslations('mobileTabBar');
  const [query, setQuery] = useState('');

  // story #3855(customer-zero·셸, 선생님 07:07Z 지적 → 페드루 PO 판정 2026-09-14 07:34Z,
  // 유나 시안 77731332) — 「그 밖의 화면」은 단일 카드로 유지하되(카드 자체를 쪼개지
  // 않는다), 카드 안을 §② 흡수 지도 머리말별 소묶음(sub-heading+개수 pill+구분선)으로
  // 나눈다 — groupVisibleLegacyByTarget()이 데스크톱 「더보기」와 같은 묶음·같은
  // 머리말을 낸다(nav-config.ts SSOT, AC3). 흡수 화면이 착지해 어느 머리말의 항목이
  // 0이 되면 그 소묶음만 안 뜬다(빈 묶음 렌더 0, AC4 — groupVisibleLegacyByTarget이
  // 이미 빈 그룹을 걸러 낸다). 카드 자체가 비면(전 소묶음 0) 카드도 안 뜬다.
  // story #4278(유나 결정 ①②) — 구역 · 빼는 항목 · 머리 안내의 탭 이름이 모두 «지금 탭바가 그리는 탭»(플래그)에서 나온다
  // (nav-config.ts buildMobileHubGroups · mobile-tab-bar.tsx tabDestinationNavIds · visibleTabLabels).
  const LEGACY_CARD_ID = MOBILE_LEGACY_CARD_ID;
  const { navV3Flags, orgId, orgMemberships, currentProjectSlug } = useDashboardContext();
  // story #4274(유나 실측 · PO) — resource 항목(목표 · 문서 · 루프 · 산출물 · 스토리지 · 보드)은 사이드바 · 탭바와 같은 scopedResourceHref로
  // `/{ws}/{proj}/{자원}` 직접 주소를 만든다. 예전엔 bare `/goals`라 proxy의 legacyResourceRedirect(307) 동안 로딩 경계가 설 자리가 없어
  // 390에서 1.45~1.54초 «전체» 화면이 그대로였다. slug를 모르는 찰나에만 flat + `?p=`(useFlatHref).
  const orgSlug = orgMemberships.find((o) => o.orgId === orgId)?.orgSlug;
  const flags = navV3Flags ?? DEFAULT_NAV_V3_FLAGS;
  const hubGroups = useMemo(() => buildMobileHubGroups({
    groups: resolveNavGroups(flags),
    groupOrder: MOBILE_HUB_GROUP_ORDER,
    legacyGroups: groupVisibleLegacyByTarget(),
    legacyItems: LEGACY_NAV_ITEMS,
    excludeIds: tabDestinationNavIds(flags),
  }), [flags]);

  const totalScreenCount = useMemo(() => hubGroups.reduce((sum, g) => sum + g.items.length, 0), [hubGroups]);
  const totalSectionCount = hubGroups.length;

  // story #4278(유나 결정 ①) — 탭 이름은 탭바가 실제로 그리는 탭 그대로(«전체» 뺌 · 탭바 순서). ko 「」·로 잇고, en은 "…"를 목록 접속으로.
  const locale = useLocale();
  const tabNames = useMemo(() => {
    const names = visibleTabLabels(flags).map(({ namespace, labelKey }) => (namespace === 'nav' ? t(labelKey) : tMore(labelKey)));
    return locale.startsWith('ko')
      ? names.map((n) => `「${n}」`).join('·')
      : new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(names.map((n) => `"${n}"`));
  }, [flags, locale, t, tMore]);

  const normalizedQuery = query.trim().toLowerCase();
  // story #fddd0e6b(C) — 찾기는 이름·설명 둘 다 부분일치(대소문자 무시)로 거른다. 서버
  // 호출 0·상태는 로컬(이미 만든 hubGroups를 그 자리서 거를 뿐 — 원천 하나).
  const filteredGroups = useMemo(() => {
    if (!normalizedQuery) return hubGroups;
    const matches = (item: (typeof hubGroups)[number]['items'][number]) => {
      const label = t(item.labelKey).toLowerCase();
      const description = t(item.descriptionKey).toLowerCase();
      return label.includes(normalizedQuery) || description.includes(normalizedQuery);
    };
    return hubGroups
      .map((g) => ({
        ...g,
        items: g.items.filter(matches),
        subgroups: g.subgroups
          ?.map((sg) => ({ ...sg, items: sg.items.filter(matches) }))
          .filter((sg) => sg.items.length > 0),
      }))
      .filter((g) => g.items.length > 0);
  }, [hubGroups, normalizedQuery, t]);

  return (
    // story #4130 — 이 페이지엔 스크롤 영역 위에 고정해 둘 별도 툴바가 없다(TopBarSlot은
    // 포털이라 로컬 공간을 안 씀) — 로컬 min-h-0/flex-1/overflow-y-auto 경계를 걷어내고
    // 셸의 단일 스크롤러(:199)가 그대로 스크롤하게 둔다(gates/[id]/page.tsx와 동형 처리,
    // #4121 픽스가 기대하는 «콘텐츠 높이로 자란다» 그 자체).
    <div className="flex flex-col p-4">
      {/* 근본 재구현(2076 회귀 후속, 유나양 규격) — 이 4탭 루트는 TopBarSlot을 아예 안 써서
          allowlist(showContextChip)로 켤 자리가 없었다. "슬롯 없으면 자동 켬"은 fail-open이라
          금지(유나양) — 슬롯을 명시적으로 쓰게 해서 켠다.
          story #fddd0e6b(B) — 「전체」(mobileTabBar.more, 탭 이름)와 「전체 메뉴」(페이지
          제목, 새 키)는 다른 값이다 — 재사용 아님. */}
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('moreMenuTitle')}</h1>} showContextChip />
      {/* story #4222(유나 design) — space-y는 display:none 형제도 세어, 숨은 탭 문장(lg:hidden)이 마지막 자식이 되면 부제에
          margin 4px가 남아 데스크톱 검색창이 104→108px로 밀렸다. flex+gap은 숨은 자식에 간격을 안 준다. */}
      <div className="mb-4 flex flex-col gap-1">
        <p className="text-xs text-muted-foreground" data-testid="more-subtitle">
          {t('moreSubtitle', { n: totalScreenCount, g: totalSectionCount })}
        </p>
        {/* story #fddd0e6b(AC1②) — 탭 바가 실제로 있을 때만(useIsMobile() true) 이 문장을
            그린다. 데스크톱 폭에선 탭 바 자체가 없어 「아래 탭에 있다」가 거짓이 된다. */}
        {/* story #4222 — useIsMobile()로 렌더를 가르면 서버·첫 렌더엔 없다가 하이드레이션 뒤 모바일에서 한 줄이 생겨 아래가 밀렸다.
            늘 그리고 lg:(탭 바가 없는 폭 · 훅의 1024)에서만 숨긴다(display:none — 데스크톱 스크린리더에도 안 읽힘). */}
        {(
          <p className="text-xs text-muted-foreground lg:hidden" data-testid="more-tab-hint">
            {t('moreTabHint', { tabs: tabNames })}
          </p>
        )}
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
          {filteredGroups.map((group) => {
            const isLegacy = group.id === LEGACY_CARD_ID;
            const renderItemRow = (item: (typeof group.items)[number]) => {
              const href = item.kind === 'static' ? flatHref(item.path) : scopedResourceHref(item.path, orgSlug, currentProjectSlug, flatHref);
              const Icon = item.icon;
              return (
                <Link
                  key={item.id}
                  href={href}
                  className="flex min-h-12 items-start gap-3 px-5 py-3 text-sm text-foreground hover:bg-muted sm:px-6"
                  data-testid="more-menu-link"
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
            };
            // story #4292 — 머리 규칙은 구역 조립 한 곳(sectionHeader): 한 항목 이름과 같은 글자의 머리는 그리지 않는다(사이드바와 같은 모양).
            // 머리를 안 그린 카드도 구역으로 읽히게 role=group + 번역된 구역 이름(까디르 QA ②).
            const { headerKey, name: sectionName } = sectionHeader(group, (key) => t(key));
            return (
              <Card
                key={group.id}
                className="overflow-hidden"
                data-testid="more-section-card"
                {...(headerKey ? {} : { role: 'group', 'aria-label': sectionName })}
              >
                {headerKey ? (
                  <CardHeader>
                    {/* story #3824 → #4292 — 머리 없는 구역이 여러 항목이면 첫 항목 이름을 머리로 쓴다. 한 항목 구역은 머리 자체가
                        없다(sectionHeader — 예전엔 그 항목 이름을 끌어와 «결과 › 결과»로 두 번 보였다). */}
                    <h2 className="flex items-baseline gap-2 text-sm font-semibold text-foreground">
                      <span data-testid="more-section-header">{t(headerKey)}</span>
                      {/* story #3855(픽셀 커밋, 페드루 PO 판정 2026-09-14 07:34Z ⑥) — 카드
                          헤더 옆 작은 캡션(§⑤ 해요체) — 데스크톱 「더보기」 캡션과 같은
                          낱말, 여기선 카드 헤더에 붙는다(별도 페이지 줄이 아님). */}
                      {isLegacy ? (
                        <span
                          className="text-[10.5px] font-medium text-muted-foreground"
                          data-testid="legacy-moving-caption"
                        >
                          {t('moreLegacyMovingCaptionInline')}
                        </span>
                      ) : null}
                    </h2>
                  </CardHeader>
                ) : null}
                {isLegacy && group.subgroups ? (
                  <div>
                    {group.subgroups.map((sg, i) => (
                      <div key={sg.target} data-legacy-group={sg.target}>
                        {i > 0 ? <div className="mx-5 my-1.5 h-px bg-border sm:mx-6" /> : null}
                        <p className="flex items-baseline gap-1.5 px-5 pt-1 pb-0.5 sm:px-6">
                          <span className="text-[11px] font-bold text-muted-foreground">{t(sg.labelKey)}</span>
                          <span className="rounded-full bg-muted px-1.5 text-[10px] font-bold leading-[15px] text-muted-foreground">
                            {sg.items.length}
                          </span>
                        </p>
                        <div className="divide-y divide-border">{sg.items.map(renderItemRow)}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="divide-y divide-border">{group.items.map(renderItemRow)}</div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

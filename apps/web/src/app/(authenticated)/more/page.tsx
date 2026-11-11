'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, Search } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Card } from '@/components/ds/card';
import { Icon } from '@/components/ds/icon';
import { ListRow } from '@/components/ds/list-row';
import { SectionHeader } from '@/components/ds/section-header';
import { RAIL_ICON_BY_ITEM_ID } from '@/components/nav/rail-icons';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { MOBILE_HUB_GROUP_ORDER, OTHER_NAV_ITEMS, resolveNavGroups } from '@/lib/nav-config';
import { buildMobileHubGroups, sectionHeader } from '@/lib/mobile-hub-groups';
import { DEFAULT_NAV_V3_FLAGS, scopedResourceHref } from '@/lib/nav-v3-destinations';
import { tabDestinationNavIds, visibleTabLabels } from '@/components/nav/mobile-tab-bar';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { useFlatHref } from '@/hooks/use-flat-href';
import { MoreTopBarTitle } from '@/components/nav/flat-tab-top-bar';
import { useCommandPaletteOpener } from '@/components/command-palette/command-palette-context';

// story #2682(모바일 IA S2, doc mobile-ia-full-completion-2678 §2.3) — 임시 평면 stub(#1958·
// #1965)을 그룹형 허브로 재건한다. 구역·항목의 «종류»는 데스크톱 길잡이(app-sidebar.tsx)와 같은 한 정의(NAV_GROUPS)이고, «순서»는 폰 탭에 맞춰 따로 정한다(MOBILE_HUB_GROUP_ORDER — 사이드바 순서와 다르다).
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
  const openPalette = useCommandPaletteOpener();
  const tMore = useTranslations('mobileTabBar');
  const [query, setQuery] = useState('');

  // story #4885(UI-2 AC4 PR 1) — 구역 · 항목은 사이드바와 같은 한 정의(nav-config.ts)에서, 빼는 항목 · 머리 안내의 탭 이름은 «지금 탭바가 그리는 탭»에서 나온다
  // (nav-config.ts buildMobileHubGroups · mobile-tab-bar.tsx tabDestinationNavIds · visibleTabLabels). 맨 아래 «그 밖의 화면»은 메뉴 입구를 따로 안 만드는 화면들.
  const { navV3Flags, orgId, orgMemberships, currentProjectSlug } = useDashboardContext();
  // story #4274(유나 실측 · PO) — resource 항목(목표 · 문서 · 루프 · 산출물 · 스토리지 · 보드)은 사이드바 · 탭바와 같은 scopedResourceHref로
  // `/{ws}/{proj}/{자원}` 직접 주소를 만든다. 예전엔 bare `/goals`라 proxy의 legacyResourceRedirect(307) 동안 로딩 경계가 설 자리가 없어
  // 390에서 1.45~1.54초 «전체» 화면이 그대로였다. slug를 모르는 찰나에만 flat + `?p=`(useFlatHref).
  const orgSlug = orgMemberships.find((o) => o.orgId === orgId)?.orgSlug;
  const flags = navV3Flags ?? DEFAULT_NAV_V3_FLAGS;
  const hubGroups = useMemo(() => buildMobileHubGroups({
    groups: resolveNavGroups(flags),
    groupOrder: MOBILE_HUB_GROUP_ORDER,
    otherItems: OTHER_NAV_ITEMS,
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
      .map((g) => ({ ...g, items: g.items.filter(matches) }))
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
      <TopBarSlot title={<MoreTopBarTitle />} showContextChip />
      {/* story #4413(유나 자리 결정) — 전역 검색(명령 팔레트) 폰 진입점 · 이 목록 맨 위. «전체»는 시트가 아니라 페이지라 닫을 것 없이 팔레트 한 겹만 열린다.
          story 4889(PO 판정 캡처) — 아래 «화면 이름으로 찾기» 입력칸과 같은 «검색 칸 둘»로 읽혔다(돋보기 + «검색…» 회색 칸이 둘). 둘은 다른 일이라(위 = 팔레트를 연다 · 아래 = 이 목록만 거른다)
          합치지 않고 «모양 · 이름»을 가른다: 위는 입력칸이 아니라 단추(진한 글 + 오른쪽 ›, 이름 «전체 검색 열기»), 아래 입력칸은 «이 목록에서 …»라고 범위를 말한다. */}
      {openPalette && (
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={openPalette}
          data-testid="more-global-search"
          className="mb-4 w-full justify-start gap-2 px-3 font-medium text-foreground"
        >
          <Search className="size-4" aria-hidden="true" />
          <span className="flex-1 truncate text-left">{t('moreGlobalSearch')}</span>
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
        </Button>
      )}
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
            // story #4885 — 줄은 ds ListRow(asChild · 기본 높이 · 폰 누름 영역 44 이상) + 항목 아이콘 표(막대 · 길잡이와 같은 rail-icons). 설명은 잘리지 않게 줄바꿈을 허용한다(ListRow 둘째 줄은 한 줄 고정폭이라 안 쓴다).
            const renderItemRow = (item: (typeof group.items)[number]) => {
              const href = item.kind === 'static' ? flatHref(item.path) : scopedResourceHref(item.path, orgSlug, currentProjectSlug, flatHref);
              const glyph = RAIL_ICON_BY_ITEM_ID[item.id];
              return (
                <ListRow key={item.id} asChild className="items-start last:border-b-0">
                  <Link href={href} data-testid="more-menu-link">
                    {glyph ? <Icon name={glyph} size={20} className="mt-0.5 text-ds-ink-3" /> : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ds-body font-semibold text-ds-ink">{t(item.labelKey)}</span>
                      {/* 페드루 PO CHANGES①(2026-09-09, 캡처 리뷰) — 설명은 잘리면 정보가 조용히 버려진다(EN 긴 문안이 390px·sm 2열에서 「…」로 죽음). 제목 줄만 truncate, 설명은 줄바꿈 허용. */}
                      <span className="block text-ds-small text-ds-ink-3">{t(item.descriptionKey)}</span>
                    </span>
                  </Link>
                </ListRow>
              );
            };
            // story #4292 — 머리 규칙은 구역 조립 한 곳(sectionHeader): 한 항목 이름과 같은 글자의 머리는 그리지 않는다(사이드바와 같은 모양).
            // story #4291(PO) — 머리를 안 그린 카드엔 group 이름을 붙이지 않는다: 머리가 없는 건 구역 이름이 그 한 항목 이름과 같을 때라
            // (sectionHeader), 붙이면 화면 읽기가 같은 낱말을 두 번(«오늘» 묶음 · «오늘» 링크) 읽는다. 항목 링크 자체가 이름이다.
            const { headerKey } = sectionHeader(group, (key) => t(key));
            return (
              <Card
                key={group.id}
                className="overflow-hidden"
                data-testid="more-section-card"
              >
                {headerKey ? (
                  // story #3824 → #4292 — 머리 없는 구역이 여러 항목이면 첫 항목 이름을 머리로 쓴다. 한 항목 구역은 머리 자체가 없다(sectionHeader — 예전엔 «결과 › 결과»로 두 번 보였다).
                  <SectionHeader title={t(headerKey)} level={2} />
                ) : null}
                <div>{group.items.map(renderItemRow)}</div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

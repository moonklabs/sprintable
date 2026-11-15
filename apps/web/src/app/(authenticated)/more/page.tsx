'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Card } from '@/components/ds/card';
import { Icon } from '@/components/ds/icon';
import { ListRow } from '@/components/ds/list-row';
import { SectionHeader } from '@/components/ds/section-header';
import { RAIL_ICON_BY_ITEM_ID } from '@/components/nav/rail-icons';
import { Button } from '@/components/ds/button';
import { Input } from '@/components/ds/input';
import { IconButton } from '@/components/ds/icon-button';
import { CountBadge } from '@/components/ds/count-badge';
import { useTeamPresenceToggle } from '@/components/presence/team-presence-toggle';
import { useReleaseNotes } from '@/components/release-notes/release-notes-gate';
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
      {/* story 4890 (UI-7 · 전체 화면 통째): 폰 «전체»는 한 줄 검색 하나로 시작한다 — 입력칸(이 목록의 화면 이름을 거름) + 오른쪽 돋보기 단추(전체 검색 · 명령 팔레트를 연다). 전엔 «전체 검색 열기» 단추 · «24개 화면 · 7개 구역» ·
          탭 안내 두 줄 · «이 목록에서 …» 입력칸이 첫 내용 앞에 28%를 차지했다. 둘은 여전히 다른 일이라(오른쪽 단추 = 팔레트 · 입력칸 = 이 목록만 거름) 이름을 가른다 — 입력칸은 범위를 말하고(moreSearchPlaceholder) 단추는 «전체 검색 열기». */}
      <div className="mb-4 flex items-center gap-2">
        <Input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('moreSearchPlaceholder')}
          aria-label={t('moreSearchPlaceholder')}
          className="min-w-0 flex-1"
          data-testid="more-search-input"
        />
        {openPalette ? <IconButton icon="search" label={t('moreGlobalSearch')} size="lg" variant="quiet" onClick={openPalette} data-testid="more-global-search" /> : null}
      </div>
      {/* story 4890 — 머리줄에서 빠진 둘(팀 현황 · 새 소식)의 새 자리: 탭 바가 있는 폭에서만, 구역들 앞에 한 카드 두 줄. 이름 · 동작은 머리줄 단추와 같다(같은 문맥 · 같은 열기). */}
      <ShellShortcuts />
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
      <p className="mt-4 text-ds-small text-ds-ink-3 lg:hidden" data-testid="more-tab-hint">
        {t('moreTabHint', { tabs: tabNames })}
      </p>
    </div>
  );
}

/** 팀 현황 · 새 소식 — 머리줄(폰 폭)에서 옮겨 온 두 줄. 컨텍스트가 없으면(provider 밖) 그 줄은 그리지 않는다(머리줄 단추와 같은 규칙). */
function ShellShortcuts() {
  const tPresence = useTranslations('presence');
  const tNotes = useTranslations('releaseNotes');
  const presence = useTeamPresenceToggle();
  const notes = useReleaseNotes();
  if (!presence && !notes) return null;
  return (
    <Card className="mb-4 overflow-hidden lg:hidden" data-testid="more-shell-shortcuts">
      {presence ? (
        <ListRow asChild>
          <Button type="button" variant="quiet" onClick={presence.toggle} aria-pressed={presence.open} aria-label={presence.workingCount > 0 ? tPresence('fabLabelWorking', { count: presence.workingCount }) : tPresence('panelTitle')} data-testid="more-shortcut-presence" className="h-auto w-full justify-start gap-3 rounded-none border-0 border-b px-4 py-2 text-left last:border-b-0">
            <Icon name="groups" size={20} className="text-ds-ink-3" />
            <span className="min-w-0 flex-1 text-left text-ds-body font-semibold text-ds-ink">{tPresence('panelTitle')}</span>
            {/* the button's own name carries the number (as the header button did) — the badge is only the picture of it */}
            {presence.workingCount > 0 ? <CountBadge count={presence.workingCount} aria-hidden /> : null}
          </Button>
        </ListRow>
      ) : null}
      {notes ? (
        <ListRow asChild className="last:border-b-0">
          <Button type="button" variant="quiet" onClick={notes.open} data-testid="more-shortcut-news" className="h-auto w-full justify-start gap-3 rounded-none border-0 border-b px-4 py-2 text-left last:border-b-0">
            <Icon name="auto_awesome" size={20} className="text-ds-ink-3" />
            <span className="min-w-0 flex-1 text-left text-ds-body font-semibold text-ds-ink">{tNotes('openButtonAriaLabel')}</span>
            {notes.hasUnseen ? <span className="size-2 rounded-full bg-ds-action" aria-hidden /> : null}
          </Button>
        </ListRow>
      ) : null}
    </Card>
  );
}

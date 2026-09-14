'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Card, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useIsMobile } from '@/hooks/use-mobile';
import { groupVisibleLegacyByTarget, MOBILE_HUB_EXCLUDE_IDS, MOBILE_HUB_GROUP_ORDER, NAV_GROUPS } from '@/lib/nav-config';
import { pickEunNeunJosa } from '@/lib/korean-particle';

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

  // story #3855(customer-zero·셸, 선생님 07:07Z 지적 → 페드루 PO 판정 2026-09-14 07:34Z,
  // 유나 시안 77731332) — 「그 밖의 화면」은 단일 카드로 유지하되(카드 자체를 쪼개지
  // 않는다), 카드 안을 §② 흡수 지도 머리말별 소묶음(sub-heading+개수 pill+구분선)으로
  // 나눈다 — groupVisibleLegacyByTarget()이 데스크톱 「더보기」와 같은 묶음·같은
  // 머리말을 낸다(nav-config.ts SSOT, AC3). 흡수 화면이 착지해 어느 머리말의 항목이
  // 0이 되면 그 소묶음만 안 뜬다(빈 묶음 렌더 0, AC4 — groupVisibleLegacyByTarget이
  // 이미 빈 그룹을 걸러 낸다). 카드 자체가 비면(전 소묶음 0) 카드도 안 뜬다.
  const LEGACY_CARD_ID = 'legacy-other-screens';
  const legacySubgroups = useMemo(() => groupVisibleLegacyByTarget(), []);
  const legacyItems = useMemo(() => legacySubgroups.flatMap((g) => g.items), [legacySubgroups]);

  const hubGroups = useMemo(
    () =>
      [
        ...MOBILE_HUB_GROUP_ORDER
          .map((groupId) => NAV_GROUPS.find((g) => g.id === groupId))
          .filter((g): g is NonNullable<typeof g> => !!g)
          .map((g) => ({
            id: g.id,
            labelKey: g.labelKey,
            items: g.items.filter((item) => !MOBILE_HUB_EXCLUDE_IDS.has(item.id)),
            subgroups: undefined as typeof legacySubgroups | undefined,
          })),
        { id: LEGACY_CARD_ID, labelKey: 'moreOtherScreens', items: legacyItems, subgroups: legacySubgroups },
      ].filter((g) => g.items.length > 0),
    [legacyItems, legacySubgroups],
  );

  const totalScreenCount = useMemo(() => hubGroups.reduce((sum, g) => sum + g.items.length, 0), [hubGroups]);
  const totalSectionCount = hubGroups.length;

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
              // story #3824 — nav.chats 값이 바뀌어도(받침 유무 무관) 항상 맞는 조사.
              particle: pickEunNeunJosa(t('chats')),
              // story #3824 CHANGES②(페드루 PO 確定, 2026-09-13 09:01Z) — "같은 사실=같은
              // 낱말": 바텀 탭 「지금」·「채팅」과 허브 「오늘」·「대화」는 같은 두 화면을
              // 가리키므로 문구 값이 아니라 labelKey 자체를 공유한다(nav.zoneNow·nav.chats
              // — mobile-tab-bar.tsx의 TABS도 이제 이 두 키를 그대로 쓴다). 「결재」 탭은
              // 모바일 IA 통합 후속 카드 스코프라 tMore('approvals') 그대로.
              now: t('zoneNow'), approvals: tMore('approvals'), chat: t('chats'),
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
          {filteredGroups.map((group) => {
            const isLegacy = group.id === LEGACY_CARD_ID;
            const renderItemRow = (item: (typeof group.items)[number]) => {
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
            };
            return (
              <Card key={group.id} className="overflow-hidden">
                <CardHeader>
                  {/* story #3824(UX-v3·FE 1) — 헤더리스 1항목 그룹(now·dev·results, app-
                      sidebar.tsx와 동형 관례)은 카드에서도 제목이 있어야 하니 그 유일한
                      항목 자신의 라벨을 쓴다(그 그룹의 정체성이 곧 그 항목이라 desktop과
                      같은 낱말이 뜬다).
                  */}
                  <h2 className="flex items-baseline gap-2 text-sm font-semibold text-foreground">
                    <span>{group.labelKey ? t(group.labelKey) : t(group.items[0]!.labelKey)}</span>
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

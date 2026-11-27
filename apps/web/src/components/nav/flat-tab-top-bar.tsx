'use client';

import { useLayoutEffect, type ComponentProps, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTopBar } from '@/components/nav/top-bar-context';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { OrgTitle } from '@/components/organization/org-screen-title';

/**
 * story #4326 — «전체» · «결재» · «대화»로 옮기는 사이(옛 화면 언마운트 → 도착 화면 마운트 전 · loading.tsx가 뜬 동안) 상단바 제목 · 칩이
 * 0.3~1.4초 비었다(402 · 배포 30 곁 측정). 4291 AC3가 일감 탭에서 막은 부류의 남은 자리 — 같은 방식: 도착 화면이 쓰는 제목을 **폴백**으로 쥔다
 * (top-bar-context `holdFallback` · 화면 슬롯이 붙으면 늘 그쪽이 이긴다). 제목 모양은 화면과 폴백이 **같은 컴포넌트**를 써서 갈리지 않는다.
 */

/** plain words of the «More» title — passed as `titleText` (story 5031 5a) */
export function useMoreTopBarTitleText(): string {
  const tMoreText = useTranslations('nav');
  return tMoreText('moreMenuTitle');
}

/** «전체»(/more) 상단바 제목 — 화면(more/page)과 폴백(more/loading)이 같이 쓴다. */
export function MoreTopBarTitle() {
  const text = useMoreTopBarTitleText();
  return <h1 className="text-sm font-medium">{text}</h1>;
}

/** «대화»(/chats) 상단바 제목 — 화면(chats/page)과 폴백(chats/loading)이 같이 쓴다. story 5032 (C2 · PO 11-26): the list's own head already says «대화 N» right under the bar, so the bar carries only the project chip — the word twice was the teacher's duplicate. */
export function ChatsTopBarTitle() {
  return null;
}

/** plain words of the «Chats» title: none (it draws nothing) — passed as `titleText` (story 5031 5a) */
export function useChatsTopBarTitleText(): string {
  return '';
}

export type InboxTabKey = 'attention' | 'notifications' | 'gates';

/** 결재 탭 이름 표 — 화면의 탭 줄 · 상단바 제목 · 폴백이 한 곳에서 읽는다(story #2164: 헤더는 늘 지금 탭의 진짜 이름). */
export function useInboxTabLabels(): ReadonlyArray<{ key: InboxTabKey; label: string }> {
  const tInbox = useTranslations('inbox');
  const tCage = useTranslations('cage');
  return [
    { key: 'attention', label: tInbox('attentionTabLabel') },
    { key: 'notifications', label: tInbox('notificationsTabLabel') },
    { key: 'gates', label: tCage('gateTabLabel') },
  ];
}

/** «결재»(/inbox) 상단바 제목 — 알림 탭이면 안 읽은 수(모르면 0 → 안 붙임 · story #4281). 화면과 폴백이 같이 쓴다. */
export function InboxTopBarTitle({ tab, unreadCount = 0 }: { tab: string; unreadCount?: number }) {
  const labels = useInboxTabLabels();
  const label = labels.find((l) => l.key === tab)?.label ?? labels.find((l) => l.key === 'notifications')!.label;
  return (
    <div className="flex items-center gap-2">
      <h1 className="text-sm font-medium">{label}</h1>
      {/* story #4281 — 이 숫자는 알림 탭의 안 읽은 수다. 오늘 · 결재함 탭엔 그 탭의 수를 모르므로 안 붙인다. */}
      {tab === 'notifications' && unreadCount > 0 ? (
        <span className="text-sm tabular-nums text-muted-foreground">{unreadCount}</span>
      ) : null}
    </div>
  );
}

/**
 * 폴백을 쥐는 조각 — loading.tsx에 둔다(도착 화면이 붙기 전 구간에만 산다). 칠해지기 전에 쥐도록 layout effect(한 프레임이라도 빈 상단바를
 * 칠하지 않게) · 떠날 때 비운다(화면 슬롯이 이미 붙어 있으니 비워도 안 보인다).
 */
export function TopBarFallbackHolder({ title, titleText, showContextChip }: { title: ReactNode; /** story 5031 (5a): the title's plain words (the path's last crumb) */ titleText?: string; showContextChip: boolean }) {
  const { holdFallback } = useTopBar();
  useLayoutEffect(() => {
    // 자기가 세운 폴백만 치운다(떠나는 쪽의 늦은 정리가 도착 폴백을 지우지 않게 · top-bar-context holdFallback).
    return holdFallback({ title, titleText, showContextChip });
    // title은 경로 · 로케일에서만 파생 — 매 렌더 새 엘리먼트라 deps에 넣지 않는다(4291 WorkTabTitleFallback과 같은 이유). titleText도 같은 로케일 파생.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdFallback, showContextChip, titleText]);
  return null;
}

/** plain words of the «Channel» title — passed as `titleText` (story 5031 5a) */
export function useChannelTopBarTitleText(): string {
  const tChannelText = useTranslations('channel');
  return tChannelText('title');
}

/** «채널»(/channel) 상단바 제목 — 화면(OrgScreenTitle)과 폴백이 같은 모양을 쓴다(4913 · 채널). */
export function ChannelTopBarTitle() {
  const text = useChannelTopBarTitleText();
  // 연결 상태는 위 막대의 점이 아니라 화면 머리의 글 칩이 말한다(점은 «connected» 같은 영어 title만 가졌다).
  return <OrgTitle>{text}</OrgTitle>;
}

/** plain words of the «Settings» title — passed as `titleText` (story 5031 5a) */
export function useSettingsTopBarTitleText(): string {
  const tSettingsText = useTranslations('settings');
  return tSettingsText('title');
}

/** «설정»(/settings) 상단바 제목 — story 5031 (5a): 막대의 길(조직 › 설정 › 지금 칸)은 lg부터라 폴백도 lg부터만 그린다(폰은 목록 · 뒤로 줄이 이름을 말한다). 화면이 붙으면 지금 탭 이름이 이 자리를 대신한다(그때 «설정»은 길의 자리 칸이 말한다). */
export function SettingsTopBarTitle() {
  const text = useSettingsTopBarTitleText();
  return <span className="hidden text-sm font-medium lg:block">{text}</span>;
}

/** plain words of the «Rewards» title — passed as `titleText` (story 5031 5a) */
export function useRewardsTopBarTitleText(): string {
  const tRewardsText = useTranslations('rewards');
  return tRewardsText('title');
}

/** «보상»(/rewards) 상단바 제목 — 화면과 폴백이 같이 쓴다. */
export function RewardsTopBarTitle() {
  const text = useRewardsTopBarTitleText();
  return <h1 className="text-sm font-medium">{text}</h1>;
}

/** plain words of the «Goals» title — passed as `titleText` (story 5031 5a) */
export function useGoalsTopBarTitleText(): string {
  const tGoalsText = useTranslations('goals');
  return tGoalsText('title');
}

/** «목표»(`[ws]/[proj]/goals` 목록) 상단바 제목 — 화면(목록 · 로딩 분기)과 폴백이 같이 쓴다. 본문 마스트헤드가 진짜 h1이라 비-헤딩(story #3945). */
export function GoalsTopBarTitle() {
  const text = useGoalsTopBarTitleText();
  return <p className="text-sm font-medium">{text}</p>;
}

/** plain words of the «Loops» title — passed as `titleText` (story 5031 5a) */
export function useLoopsTopBarTitleText(): string {
  const tLoopsText = useTranslations('loops');
  return tLoopsText('title');
}

/** «실행»(`[ws]/[proj]/loops` 목록) 상단바 제목 — 화면(목록 · 로딩 분기)과 폴백이 같이 쓴다. */
export function LoopsTopBarTitle() {
  const text = useLoopsTopBarTitleText();
  return <h1 className="text-sm font-medium">{text}</h1>;
}

/** plain words of the «Docs» title — passed as `titleText` (story 5031 5a) */
export function useDocsTopBarTitleText(): string {
  const tDocsText = useTranslations('docs');
  return tDocsText('title');
}

/** «문서»(`[ws]/[proj]/docs` 목록) 상단바 제목 — 상단바 크롬이라 비-헤딩(story #3945 · 본문 h1과 겹치지 않게). */
export function DocsTopBarTitle() {
  const text = useDocsTopBarTitleText();
  return <p className="text-sm font-medium">{text}</p>;
}

/** plain words of the «OrgRoles» title — passed as `titleText` (story 5031 5a) */
export function useOrgRolesTopBarTitleText(): string {
  const tOrgRolesText = useTranslations('organization');
  return tOrgRolesText('rolesTitle');
}

/** «활동 로그»(/activity 첫 탭 = 감사 로그) 상단바 제목. */
/** «권한»(`organization/roles`) 상단바 제목 — 화면(OrgScreenTitle)과 폴백이 같은 모양(OrgTitle)을 쓴다. */
export function OrgRolesTopBarTitle() {
  const text = useOrgRolesTopBarTitleText();
  return <OrgTitle>{text}</OrgTitle>;
}

/** plain words of the «OrgTrust» title — passed as `titleText` (story 5031 5a) */
export function useOrgTrustTopBarTitleText(): string {
  const tOrgTrustText = useTranslations('organization');
  return tOrgTrustText('trustSlotTitle');
}

/** «신뢰 센터»(`organization/trust`) 상단바 제목 — 화면(OrgScreenTitle)과 폴백이 같은 모양(OrgTitle)을 쓴다. */
export function OrgTrustTopBarTitle() {
  const text = useOrgTrustTopBarTitleText();
  return <OrgTitle>{text}</OrgTitle>;
}

/** plain words of the «OrgGenerationConnectors» title — passed as `titleText` (story 5031 5a) */
export function useOrgGenerationConnectorsTopBarTitleText(): string {
  const tOrgGenerationConnectorsText = useTranslations('organization');
  return tOrgGenerationConnectorsText('gcTitle');
}

/** «생성 연결»(`organization/generation-connectors`) 상단바 제목 — 화면(OrgScreenTitle)과 폴백이 같은 모양을 쓴다. */
export function OrgGenerationConnectorsTopBarTitle() {
  const text = useOrgGenerationConnectorsTopBarTitleText();
  return <OrgTitle>{text}</OrgTitle>;
}

/** plain words of the «OrgContentRules» title — passed as `titleText` (story 5031 5a) */
export function useOrgContentRulesTopBarTitleText(): string {
  const tOrgContentRulesText = useTranslations('contentRules');
  return tOrgContentRulesText('pageTitle');
}

/** «콘텐츠 규칙»(`organization/content-rules`) 상단바 제목 — 화면(OrgScreenTitle)과 폴백이 같은 모양을 쓴다. */
export function OrgContentRulesTopBarTitle() {
  const text = useOrgContentRulesTopBarTitleText();
  return <OrgTitle>{text}</OrgTitle>;
}

/** plain words of the «OrgChannels» title — passed as `titleText` (story 5031 5a) */
export function useOrgChannelsTopBarTitleText(): string {
  const tOrgChannelsText = useTranslations('channelConnect');
  return tOrgChannelsText('pageTitle');
}

/** «채널 연결»(`organization/channels`) 상단바 제목 — 화면(OrgScreenTitle)과 폴백이 같은 모양을 쓴다(4913 C판). */
export function OrgChannelsTopBarTitle() {
  const text = useOrgChannelsTopBarTitleText();
  return <OrgTitle>{text}</OrgTitle>;
}

/** plain words of the «OrgInsightsBoard» title — passed as `titleText` (story 5031 5a) */
export function useOrgInsightsBoardTopBarTitleText(): string {
  const tOrgInsightsBoardText = useTranslations('insightsBoard');
  return tOrgInsightsBoardText('pageTitle');
}

/** «성과 보드»(`organization/insights-board`) 상단바 제목 — 화면(OrgScreenTitle)과 폴백이 같은 모양을 쓴다(4913 D1). */
export function OrgInsightsBoardTopBarTitle() {
  const text = useOrgInsightsBoardTopBarTitleText();
  return <OrgTitle>{text}</OrgTitle>;
}

/** plain words of the «OrgEvents» title — passed as `titleText` (story 5031 5a) */
export function useOrgEventsTopBarTitleText(): string {
  const tOrgEventsText = useTranslations('organization');
  return tOrgEventsText('eventsTitle');
}

/** «레시피»(`organization/events`) 상단바 제목 — 화면(OrgScreenTitle)과 폴백이 같은 모양을 쓴다(4913 C2). */
export function OrgEventsTopBarTitle() {
  const text = useOrgEventsTopBarTitleText();
  return <OrgTitle>{text}</OrgTitle>;
}

/** plain words of the «ContentPosts» title — passed as `titleText` (story 5031 5a) */
export function useContentPostsTopBarTitleText(): string {
  const tContentPostsText = useTranslations('content');
  return tContentPostsText('title');
}

/** «블로그 포스트»(`content`) 상단바 제목 — 화면(OrgScreenTitle)과 폴백이 같은 모양을 쓴다(4913 D물결). */
export function ContentPostsTopBarTitle() {
  const text = useContentPostsTopBarTitleText();
  return <OrgTitle>{text}</OrgTitle>;
}

/** plain words of the «ChannelPosts» title — passed as `titleText` (story 5031 5a) */
export function useChannelPostsTopBarTitleText(): string {
  const tChannelPostsText = useTranslations('content');
  return tChannelPostsText('channelPostsTitle');
}

/** «채널 포스트»(`content/channel-posts`) 상단바 제목 — 화면(OrgScreenTitle)과 폴백이 같은 모양을 쓴다(4913 D물결). */
export function ChannelPostsTopBarTitle() {
  const text = useChannelPostsTopBarTitleText();
  return <OrgTitle>{text}</OrgTitle>;
}

/** plain words of the «Activity» title — passed as `titleText` (story 5031 5a) */
export function useActivityTopBarTitleText(): string {
  const tActivityText = useTranslations('activityLog');
  return tActivityText('title');
}

export function ActivityTopBarTitle() {
  const text = useActivityTopBarTitleText();
  return <h1 className="text-sm font-medium">{text}</h1>;
}

/** plain words of the «Agents» title — passed as `titleText` (story 5031 5a) */
export function useAgentsTopBarTitleText(): string {
  const tAgentsText = useTranslations('agents');
  return tAgentsText('title');
}

/** «에이전트»(/organization/workforce) 상단바 제목 — 탭과 무관하게 고정(agents-page-tabs). */
export function AgentsTopBarTitle() {
  const text = useAgentsTopBarTitleText();
  return <h1 className="text-sm font-medium">{text}</h1>;
}

/** plain words of the «AgentRuns» title — passed as `titleText` (story 5031 5a) */
export function useAgentRunsTopBarTitleText(): string {
  const tAgentRunsText = useTranslations('agentRuns');
  return tAgentRunsText('title');
}

/** «에이전트 실행»(/organization/workforce/runs) 상단바 제목(agent-runs-list). */
export function AgentRunsTopBarTitle() {
  const text = useAgentRunsTopBarTitleText();
  return <h1 className="text-sm font-medium">{text}</h1>;
}

/** plain words of the «OrgMembers» title — passed as `titleText` (story 5031 5a) */
export function useOrgMembersTopBarTitleText(): string {
  const tOrgMembersText = useTranslations('nav');
  return tOrgMembersText('orgMembers');
}

/** «구성원»(/organization/members) 상단바 제목(story 4956 — 같은 «팀» 탭줄의 에이전트 · 실행 기록 · API 키는 제목이 있는데 구성원만 막대가 비어 있었다; 화면과 로딩 폴백이 같은 컴포넌트를 쓴다). */
export function OrgMembersTopBarTitle() {
  const text = useOrgMembersTopBarTitleText();
  return <h1 className="text-sm font-medium">{text}</h1>;
}

/** plain words of the «AgentApiKeys» title — passed as `titleText` (story 5031 5a) */
export function useAgentApiKeysTopBarTitleText(): string {
  const tAgentApiKeysText = useTranslations('settings');
  return tAgentApiKeysText('agentApiKeysPageTitle');
}

/** «에이전트 API 키»(/organization/workforce/api-keys) 상단바 제목(story 4912 B1 — 화면이 같은 컴포넌트로 슬롯을 채운다). */
export function AgentApiKeysTopBarTitle() {
  const text = useAgentApiKeysTopBarTitleText();
  return <h1 className="text-sm font-medium">{text}</h1>;
}

/** plain words of the «Storage» title — passed as `titleText` (story 5031 5a) */
export function useStorageTopBarTitleText(): string {
  const tStorageText = useTranslations('storage');
  return tStorageText('title');
}

/**
 * «스토리지»(`[ws]/[proj]/storage`) 상단바 제목 — 브레드크럼 · 이름뿐(4910 · 4913 규칙: 제목은 위 막대 한 곳).
 * 예전엔 «N개 자산 · 용량» 알약이 여기 붙었다(데이터라 화면만 넘김) — 그 개수는 본문 머리 줄로 내려갔고(`storage-asset-list` 머리), 그래서 폴백과 도착 화면이 글자까지 똑같다.
 * 폰은 브레드크럼을 숨긴다(story #4277).
 */
export function StorageTopBarTitle() {
  const text = useStorageTopBarTitleText();
  const tStorage = useTranslations('storage');
  return (
    <div className="flex min-w-0 grow items-center">
      <span className="mr-2.5 hidden shrink-0 text-xs text-muted-foreground sm:inline">{tStorage('breadcrumb')}</span>
      <span className="mr-2.5 hidden shrink-0 text-xs text-muted-foreground sm:inline">/</span>
      <h1 className="shrink-0 text-base font-[650] tracking-[-0.01em] text-foreground">{text}</h1>
    </div>
  );
}

/** plain words of the «Artifacts» title — passed as `titleText` (story 5031 5a) */
export function useArtifactsTopBarTitleText(): string {
  const tArtifactsText = useTranslations('canvas');
  return tArtifactsText('galleryTitle');
}

/**
 * «산출물»(`[ws]/[proj]/artifacts`) 상단바 제목 — 이름 하나(4910 · 4913 규칙: 제목은 위 막대 한 곳). 본문 머리에는 설명 · 개수 · «그리기 · 가져오기»만 선다.
 * 화면(`artifact-gallery-view`)과 로딩 폴백(`loading.tsx`)이 이 한 정의를 같이 쓴다.
 */
export function ArtifactsTopBarTitle() {
  const text = useArtifactsTopBarTitleText();
  return <h1 className="text-sm font-medium">{text}</h1>;
}

/**
 * story 5031 (C1 step 5a): a `TopBarSlot` whose title is one of the titles above. It carries the title's plain words as `titleText` (the desktop bar's path ends with them and drops the place's name when the title says it — a title that is a component has no words an
 * element scan can read, which made `/organization/workforce` read «조직 › 에이전트 › 에이전트»). The words come from the title's own `use…TopBarTitleText` hook, called here — not in the screen, where a hook in the middle of a big component would be a hazard.
 * A new publisher of such a title uses this (a guard — flat-tab-top-bar.titletext.guard.test.ts — fails a `<TopBarSlot title={<SomeComponent />}` that does not pass `titleText`).
 */
export function TitleTopBarSlot({ useText, ...slot }: Omit<ComponentProps<typeof TopBarSlot>, 'titleText'> & { useText: () => string }) {
  const titleText = useText();
  return <TopBarSlot {...slot} titleText={titleText} />;
}

/** the inbox's slot: the title is the tab's label with the unread count (the count is not part of the words the path compares) */
export function InboxTopBarSlot({ tab, unreadCount, actions }: { tab: string; unreadCount: number; actions?: ReactNode }) {
  const titleText = useInboxTopBarTitleText(tab);
  return <TopBarSlot title={<InboxTopBarTitle tab={tab} unreadCount={unreadCount} />} titleText={titleText} actions={actions} showContextChip />;
}

/** 결재 폴백 제목 — 도착 탭(?tab=)의 이름(수는 아직 모름 → 안 붙임). */
function InboxFallbackTitle() {
  const tab = useSearchParams().get('tab') ?? 'notifications';
  return <InboxTopBarTitle key={tab} tab={tab} />;
}

/** plain words of the inbox title: the arrival tab's label (no count) — passed as `titleText` (story 5031 5a) */
export function useInboxTopBarTitleText(tab: string): string {
  const labels = useInboxTabLabels();
  return (labels.find((l) => l.key === tab) ?? labels.find((l) => l.key === 'notifications')!).label;
}
function useInboxFallbackTitleText(): string {
  return useInboxTopBarTitleText(useSearchParams().get('tab') ?? 'notifications');
}

/**
 * PO 판단(4688) — 일감 탭 밖 목적지의 **«경로 → 제목» 표 하나**(키 = `app/(authenticated)/` 아래 경로 폴더 · 이동 주소가 아니다 — 주소는
 * nav-v3 목적지 모듈이 정한다). 각 경로의 loading.tsx가 이 표로 폴백을 쥐고, 화면은 같은 제목 컴포넌트로 슬롯을 채운다(정의 한 곳).
 * 일감 탭은 4291(WorkTabsFrame)이 따로 쥔다.
 * 목록 전용: 폴더의 loading.tsx는 그 아래 상세(`chats/[conversation_id]` · `goals/[id]`)도 덮는다 — 상세는 제목(뒤로 · 이름)이 다르고 칩이 없으니,
 * 도착 주소의 마지막 조각이 이 폴더 이름일 때(= 목록 자체)만 쥔다. 상세 로딩 중엔 예전처럼 비워 둔다(틀린 제목 · 칩을 잠깐 세우지 않게).
 */
export const FLAT_ROUTE_TOP_BAR = {
  more: { Title: MoreTopBarTitle, useText: useMoreTopBarTitleText, showContextChip: true },
  inbox: { Title: InboxFallbackTitle, useText: useInboxFallbackTitleText, showContextChip: true },
  chats: { Title: ChatsTopBarTitle, useText: useChatsTopBarTitleText, showContextChip: true },
  channel: { Title: ChannelTopBarTitle, useText: useChannelTopBarTitleText, showContextChip: true },
  rewards: { Title: RewardsTopBarTitle, useText: useRewardsTopBarTitleText, showContextChip: true },
  settings: { Title: SettingsTopBarTitle, useText: useSettingsTopBarTitleText, showContextChip: false }, // story 5031 (5a) — /settings has the bar now; the page publishes the tab's name (lg), this holds «설정» while it loads
  '[ws]/[proj]/goals': { Title: GoalsTopBarTitle, useText: useGoalsTopBarTitleText, showContextChip: true },
  '[ws]/[proj]/loops': { Title: LoopsTopBarTitle, useText: useLoopsTopBarTitleText, showContextChip: true },
  '[ws]/[proj]/docs': { Title: DocsTopBarTitle, useText: useDocsTopBarTitleText, showContextChip: true },
  '[ws]/[proj]/storage': { Title: () => <StorageTopBarTitle />, useText: useStorageTopBarTitleText, showContextChip: true },
  '[ws]/[proj]/artifacts': { Title: () => <ArtifactsTopBarTitle />, useText: useArtifactsTopBarTitleText, showContextChip: true },
  activity: { Title: ActivityTopBarTitle, useText: useActivityTopBarTitleText, showContextChip: true },
  'organization/workforce': { Title: AgentsTopBarTitle, useText: useAgentsTopBarTitleText, showContextChip: true },
  'organization/members': { Title: OrgMembersTopBarTitle, useText: useOrgMembersTopBarTitleText, showContextChip: true }, // story 4956 — 같은 «팀» 탭줄의 에이전트 화면들과 같은 칩(탭을 옮길 때 칩이 켜졌다 꺼지지 않게)
  // 4913 — 조직 구역 «한 쪽 틀» 화면: 제목은 위 막대 · 칩은 조직 화면이라 없음(화면의 OrgScreenTitle과 같다).
  'organization/roles': { Title: OrgRolesTopBarTitle, useText: useOrgRolesTopBarTitleText, showContextChip: false },
  'organization/trust': { Title: OrgTrustTopBarTitle, useText: useOrgTrustTopBarTitleText, showContextChip: false },
  'organization/generation-connectors': { Title: OrgGenerationConnectorsTopBarTitle, useText: useOrgGenerationConnectorsTopBarTitleText, showContextChip: false },
  'organization/content-rules': { Title: OrgContentRulesTopBarTitle, useText: useOrgContentRulesTopBarTitleText, showContextChip: false },
  'organization/channels': { Title: OrgChannelsTopBarTitle, useText: useOrgChannelsTopBarTitleText, showContextChip: false },
  'organization/events': { Title: OrgEventsTopBarTitle, useText: useOrgEventsTopBarTitleText, showContextChip: false },
  content: { Title: ContentPostsTopBarTitle, useText: useContentPostsTopBarTitleText, showContextChip: false },
  'organization/insights-board': { Title: OrgInsightsBoardTopBarTitle, useText: useOrgInsightsBoardTopBarTitleText, showContextChip: false },
  'content/channel-posts': { Title: ChannelPostsTopBarTitle, useText: useChannelPostsTopBarTitleText, showContextChip: false },
  // 까디르 4688 — 부모 workforce/loading이 덮던 하위 목록(마지막 조각 runs ≠ workforce라 «상세»로 봐서 빈 채였다) · 자기 loading.tsx로 쥔다.
  'organization/workforce/runs': { Title: AgentRunsTopBarTitle, useText: useAgentRunsTopBarTitleText, showContextChip: true },
  'organization/workforce/api-keys': { Title: AgentApiKeysTopBarTitle, useText: useAgentApiKeysTopBarTitleText, showContextChip: true },
} as const satisfies Record<string, { Title: () => ReactNode; /** the title's plain words (story 5031 5a: the path's last crumb) */ useText: () => string; showContextChip: boolean }>;

export type FlatRoute = keyof typeof FLAT_ROUTE_TOP_BAR;

/** 프로젝트 자원 부모 경계(`[ws]/[proj]/loading`)용 — 도착 자원 조각이 표에 있으면 그 경로. */
export function projectRouteOf(segment: string | undefined): FlatRoute | null {
  const key = `[ws]/[proj]/${segment ?? ''}`;
  return key in FLAT_ROUTE_TOP_BAR ? (key as FlatRoute) : null;
}

/** 도착 주소가 그 폴더의 목록 자체인가(마지막 조각 = 폴더 이름). 상세(`…/chats/<id>`)면 아니다. */
export function isRouteListPath(route: FlatRoute, pathname: string | null): boolean {
  const last = (pathname ?? '').split('/').filter(Boolean).pop();
  return last === route.split('/').pop();
}

/** loading.tsx 한 줄 — 그 경로의 목록으로 올 때 제목을 폴백으로 쥔다. 결재는 탭이 바뀌면 다시 쥔다(key). */
export function RouteTopBarFallback({ route }: { route: FlatRoute }) {
  const entry = FLAT_ROUTE_TOP_BAR[route];
  const pathname = usePathname();
  const tab = useSearchParams().get('tab');
  const titleText = entry.useText(); // a hook, called on every render (the route is a prop of one loading.tsx, so the same hook runs every time)
  if (!isRouteListPath(route, pathname)) return null;
  return <TopBarFallbackHolder key={route === 'inbox' ? `inbox:${tab ?? ''}` : route} title={<entry.Title />} titleText={titleText} showContextChip={entry.showContextChip} />;
}

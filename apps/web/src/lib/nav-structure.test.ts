// story #4885 (UI-2 AC4 PR 1) — 정보 구조 한 벌의 구조 시험. 영역(구역) · 순서 · 이름 · «모든 화면이 한 입구 이상» (orphan 0) · «팀/에이전트» 두 꼴.
// 되돌리면 RED: 구역을 빼거나 순서를 바꾸면 ① 순서 ② 구역별 항목 ③ orphan 단언 중 하나가 걸린다. 입구 없는 새 화면을 만들면 ④가 걸린다(의도라면 아래 DOCUMENTED_EXCEPTIONS에 이유와 함께 한 줄).
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_SCREENS_ITEM,
  CHAT_CENTER_ITEM,
  MOBILE_HUB_GROUP_ORDER,
  NAV_GROUPS,
  OTHER_NAV_ITEMS,
  TEAM_VARIANT,
  buildNavGroups,
  allNavItems,
  type NavGroupConfig,
  type TeamVariant,
} from './nav-config';
import { GUARD_ANCHOR_ITEMS } from '@/components/command-palette/command-palette';
import { WORKSPACE_FRAME_TAB_PATHS } from '@/components/workspace/workspace-frame-tabs';
import koMessages from '../../messages/ko.json';
import enMessages from '../../messages/en.json';

const APP_DIR = join(__dirname, '..', 'app');

const ids = (groups: NavGroupConfig[], id: string) => groups.find((g) => g.id === id)?.items.map((i) => i.id) ?? [];

describe('정보 구조 한 벌 — 구역 · 순서 · 이름', () => {
  it('⭐구역 순서: 오늘 → 일감 → 팀/에이전트 → 지식 → 조직 → 설정 (사이드바 · 전체 · 모바일 허브가 같은 순서)', () => {
    expect(NAV_GROUPS.map((g) => g.id)).toEqual(['now', 'dev', 'team', 'knowledge', 'org', 'settings']);
    expect(MOBILE_HUB_GROUP_ORDER).toEqual(NAV_GROUPS.map((g) => g.id));
  });

  it('⭐맨 위 이름 = «팀»(선생님 결정 11-10): 기본 꼴이 «팀»이다', () => {
    expect(TEAM_VARIANT).toBe('team');
  });

  it('⭐구역별 항목과 순서(«팀» 꼴 = 기본 · 구성원이 팀 안으로 올라와 조직에는 없다)', () => {
    const g = buildNavGroups('team');
    expect(ids(g, 'now')).toEqual(['org-briefing', 'inbox']);
    expect(ids(g, 'dev')).toEqual(['board', 'goals', 'loops']);
    expect(ids(g, 'team')).toEqual(['org-members', 'org-workforce', 'org-workforce-runs', 'org-workforce-api-keys']);
    expect(ids(g, 'knowledge')).toEqual(['docs', 'artifacts', 'storage']);
    expect(ids(g, 'org')).toEqual([
      'org-insights-board', 'org-channels', 'org-generation-connectors', 'org-content-rules', 'org-events', 'org-trust', 'org-roles', 'activity', 'content', 'channel-posts',
    ]);
    expect(ids(g, 'settings')).toEqual(['settings']);
  });

  it('⭐«팀» ↔ «에이전트» 두 꼴: 한 줄(TEAM_VARIANT)로 이름 · 묶음이 바뀌고 구성원이 조직 ↔ 팀을 오간다 — 두 꼴 다 같은 규칙을 지킨다(결정은 «팀»이지만 대안 꼴도 시험이 선다)', () => {
    const team = buildNavGroups('team');
    expect(team.find((g) => g.id === 'team')?.labelKey).toBe('zoneTeam');
    expect(ids(team, 'team')).toEqual(['org-members', 'org-workforce', 'org-workforce-runs', 'org-workforce-api-keys']);
    expect(ids(team, 'org')).not.toContain('org-members');
    const agent = buildNavGroups('agent');
    expect(agent.find((g) => g.id === 'team')?.labelKey).toBeUndefined();
    expect(ids(agent, 'org')).toContain('org-members');
    // 두 꼴 모두: 모든 항목 id가 한 번만, 구역 순서 같음.
    for (const variant of ['agent', 'team'] as TeamVariant[]) {
      const all = buildNavGroups(variant).flatMap((g) => g.items.map((i) => i.id));
      expect(new Set(all).size, variant).toBe(all.length);
      expect(buildNavGroups(variant).map((g) => g.id), variant).toEqual(['now', 'dev', 'team', 'knowledge', 'org', 'settings']);
    }
    expect(NAV_GROUPS).toEqual(buildNavGroups(TEAM_VARIANT));
  });

  it('머리글(접힘 가능한 구역)은 «팀»(선생님 결정 11-10) · 지식 · 조직이고 오늘 · 일감 · 설정은 머리 없는 구역이다', () => {
    expect(NAV_GROUPS.filter((g) => g.labelKey).map((g) => g.labelKey)).toEqual(['zoneTeam', 'zoneKnowledge', 'zoneOrganization']);
  });

  it('⭐모든 항목은 ko · en 이름과 설명이 있다(키가 빠지면 RED)', () => {
    const nav = (m: Record<string, unknown>) => m['nav'] as Record<string, string>;
    for (const item of allNavItems()) {
      for (const [lang, m] of [['ko', koMessages], ['en', enMessages]] as const) {
        expect(nav(m)[item.labelKey], `${lang} nav.${item.labelKey}`).toBeTruthy();
        expect(nav(m)[item.descriptionKey], `${lang} nav.${item.descriptionKey}`).toBeTruthy();
      }
    }
    for (const key of ['navAll', 'zoneTeam', 'zoneOrganization', 'zoneKnowledge']) {
      expect((koMessages.nav as Record<string, string>)[key], `ko nav.${key}`).toBeTruthy();
      expect((enMessages.nav as Record<string, string>)[key], `en nav.${key}`).toBeTruthy();
    }
  });

  it('«전체»는 폰 탭 «전체»와 같은 /more 한 곳이다', () => {
    expect(ALL_SCREENS_ITEM.path).toBe('/more');
  });

  it('⭐같은 사실 = 같은 낱말: 결재 항목은 폰 하단 «결재» 탭과 같은 이름 · 같은 착지(게이트 탭)', () => {
    const inbox = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === 'inbox')!;
    expect(inbox.labelKey).toBe('approvals');
    expect(inbox.path).toBe('/inbox?tab=gates');
    expect(koMessages.nav.approvals).toBe(koMessages.mobileTabBar.approvals);
  });
});

describe('⭐메뉴 이름 = 그 화면을 부르는 글 (선생님 11-10: 맨 위 «오늘» → «홈»)', () => {
  // 맨 위 메뉴 이름(nav.zoneNow)이 정본이다 — 화면 제목 · 그 화면으로 보내는 길 이름(온보딩 «홈으로 가기» · 대화의 «홈 › 내 결정» · «홈»에서 서명)은 같은 낱말을 쓴다.
  // 날짜 뜻의 «오늘»(오늘 결과 · 오늘 사용량 · 스탠드업 · 날짜 묶음)은 이 단언 밖이다. 선생님이 다른 이름을 고르면 messages 값만 바꾸면 이 시험이 같이 따라온다.
  for (const [lang, m] of [['ko', koMessages], ['en', enMessages]] as const) {
    const msg = m as unknown as Record<string, Record<string, unknown>>;
    const name = msg.nav!.zoneNow as string;
    it(`${lang}: 화면 제목 · 가는 길 이름이 메뉴 이름 «${name}»과 같다`, () => {
      expect(msg.orgBriefing!.title, 'orgBriefing.title').toBe(name);
      expect(msg.todayV3!.title, 'todayV3.title(켜지지 않은 같은 이름의 시안)').toBe(name);
      expect(msg.onboarding!.desktopFinishToToday as string, 'onboarding.desktopFinishToToday').toContain(name);
      expect((msg.desktop!.setup as Record<string, string>).goToday, 'desktop.setup.goToday').toContain(name);
      expect(msg.chatV3!.contextRelatedTodayLink as string, 'chatV3.contextRelatedTodayLink').toContain(name);
      expect(msg.chatV3!.eventCardSignAction as string, 'chatV3.eventCardSignAction').toContain(name);
    });
  }
  it('정해진 이름: ko «홈» · en «Home»', () => {
    expect(koMessages.nav.zoneNow).toBe('홈');
    expect(enMessages.nav.zoneNow).toBe('Home');
  });
});

// ─── 모든 화면이 한 입구 이상 ──────────────────────────────────────────────────────────────────────────────────────────────────

function pageRoutes(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { pageRoutes(full, out); continue; }
    if (name !== 'page.tsx') continue;
    const segs = relative(APP_DIR, dir).split(sep).filter((s) => s && !/^\(.+\)$/.test(s));
    out.push('/' + segs.join('/'));
  }
  return out;
}

// 메뉴 입구가 «없어도 되는» 화면들과 까닭. 이 표는 정확해야 한다(낡은 줄 · 빠진 줄 둘 다 RED).
const DOCUMENTED_EXCEPTIONS: Record<string, string> = {
  // 로그인 전 · 계정 · 온보딩 · 공개 · 앱 연결 흐름 — 메뉴가 아니라 흐름의 한 단계
  '/': '랜딩', '/login': '로그인 흐름', '/register': '로그인 흐름', '/forgot-password': '로그인 흐름', '/reset-password': '로그인 흐름', '/set-password/confirm': '로그인 흐름',
  '/verify-email': '로그인 흐름', '/mfa': '로그인 흐름', '/auth/reset-required': '로그인 흐름', '/invite': '초대 흐름', '/invite/accept': '초대 흐름', '/unsubscribe': '메일 수신 거부 링크',
  '/terms': '공개 약관(바닥글)', '/privacy': '공개 약관(바닥글)', '/refund-policy': '공개 약관(바닥글)', '/native/continue': '앱 로그인 흐름', '/native/oauth-return': '앱 로그인 흐름',
  '/phone-landing': '폰 연결 흐름', '/phone-start': '폰 연결 흐름', '/onboarding': '온보딩 흐름', '/onboarding/first-instruction': '온보딩 흐름', '/share/[token]': '공유 링크',
  // 다른 화면 안에서 열리는 화면(상세 · 흐름의 한 단계) — 입구는 부모 화면의 본문 링크
  '/chats/[conversation_id]': '«대화» 안에서 열리는 방', '/gates/[id]': '«결재» 항목 상세', '/organization/workforce/[id]': '«에이전트» 목록의 상세',
  '/[ws]/[proj]/docs/[slug]': '«문서» 목록의 상세', '/[ws]/[proj]/docs/[slug]/view': '문서 보기', '/[ws]/[proj]/goals/[id]': '«목표» 목록의 상세', '/[ws]/[proj]/loops/[id]': '«실행» 목록의 상세',
  '/[ws]/[proj]/retro/[id]': '«회고» 상세', '/[ws]/[proj]/artifacts/[id]': '«산출물» 목록의 상세', '/content/[draftId]': '«콘텐츠» 목록의 상세', '/content/channel-posts/[draftId]': '«채널 포스트» 목록의 상세',
  '/content/channel-posts/calendar': '«채널 포스트»의 캘린더 보기', '/content/channel-posts/engagement': '«채널 포스트»의 성과 보기', '/campaigns/[campaignId]': '«콘텐츠»의 캠페인 상세',
  '/organization/connectors': '«에이전트» 설정 안의 커넥터 안내(agent-setup-section)', '/settings/integrations': '«설정» 안의 통합 화면',
  '/dashboard': '초대 수락 뒤 착지 · 옛 대시보드 셸', '/dashboard/settings': '업그레이드 안내에서 여는 설정',
  '/desktop/pair': '폰 연결 흐름', '/desktop/setup': '맥 앱 셋업 흐름', '/desktop/remote': '채팅 에이전트 줄의 원격 제어 링크', '/desktop/remote-on': '원격 제어 흐름',
  '/internal-dogfood': '내부 도그푸딩(프록시 전용)',
  // 켜지지 않은 시안 — 정본은 지금 서 있는 화면이고 v3 쪽은 켜지도 떼지도 않는다(PO 결정 11-10)
  '/today': 'v3 «오늘» 시안(플래그 꺼짐 — 정본은 /org-briefing)', '/chat': 'v3 «대화» 시안(플래그 꺼짐 — 정본은 /chats)', '/connect-rules': 'v3 «연결·규칙» 시안(플래그 꺼짐)',
  // 입구를 일부러 만들지 않는 화면
  '/organization/memory': '«아직 준비 중인 화면이에요» 뿐이라 story #4183(유나 확認)이 일부러 메뉴에서 걷음',
  '/docs/design-tokens': '개발자용 참고 쪽(영어 고정 제목 · 로딩 경계 없음) — 사용자 메뉴에 올리지 않음',
  // 아직 입구가 없는 화면 — 후속 칸의 몫(숨기지 않고 적는다)
  '/loop-queue': '«오늘»의 주의 큐로 합쳐질 화면 — «오늘» 화면 주인(UI-5)의 칸. 지금은 주소로만 닿는다(제품 코드 안에 이 주소로 가는 링크 0 — 시험 · 예약 세그먼트 표 제외)',
};

describe('⭐모든 화면이 한 입구 이상(orphan 0) — 의도된 예외는 이유와 함께 한 표에', () => {
  // 메뉴 입구가 되는 경로 집합: 사이드바(NAV_GROUPS + 데스크톱 항목) · 그 밖 · 챗 center · 일감 탭줄 · ⌘K 앵커.
  const entryRoutes = (() => {
    const set = new Set<string>();
    for (const item of allNavItems()) {
      const path = item.path.split('?')[0]!;
      set.add(item.kind === 'resource' ? `/[ws]/[proj]/${path}` : path);
    }
    for (const p of WORKSPACE_FRAME_TAB_PATHS) set.add(`/[ws]/[proj]/${p}`);
    for (const a of GUARD_ANCHOR_ITEMS) set.add(`/[ws]/[proj]/${a.href.replace(/^\//, '')}`);
    set.add('/more');
    return set;
  })();
  const routes = pageRoutes(APP_DIR);

  it('입구도 없고 예외 표에도 없는 화면이 0이다', () => {
    const orphans = routes.filter((r) => !entryRoutes.has(r) && !(r in DOCUMENTED_EXCEPTIONS));
    expect(orphans).toEqual([]);
  });

  it('예외 표에 낡은 줄이 없다(실제 화면이 아니거나 이미 입구가 생긴 줄)', () => {
    const routeSet = new Set(routes);
    const stale = Object.keys(DOCUMENTED_EXCEPTIONS).filter((r) => !routeSet.has(r) || entryRoutes.has(r));
    expect(stale).toEqual([]);
  });

  it('입구가 가리키는 화면은 모두 실제로 있다(죽은 링크 0)', () => {
    const routeSet = new Set(routes);
    const dead = [...entryRoutes].filter((r) => !routeSet.has(r));
    expect(dead).toEqual([]);
  });

  it('⭐입구 경로(쿼리 뗀)는 서로 겹치지 않는다 — 한 화면이 두 항목의 입구면 «지금 여기»가 둘로 갈린다(codex 1판)', () => {
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const item of allNavItems()) {
      const key = `${item.kind}:${item.path.split('?')[0]}`;
      if (seen.has(key)) dup.push(`${key} ← ${seen.get(key)} · ${item.id}`);
      seen.set(key, item.id);
    }
    expect(dup).toEqual([]);
    for (const a of GUARD_ANCHOR_ITEMS) {
      expect(seen.has(`resource:${a.href.replace(/^\//, '')}`), `앵커 ${a.id}는 구역 항목과 겹치지 않는다`).toBe(false);
    }
  });

  it('«그 밖의 화면»(OTHER_NAV_ITEMS)과 챗 center는 구역(NAV_GROUPS)에 중복으로 실리지 않는다', () => {
    const inGroups = new Set(NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id)));
    expect(OTHER_NAV_ITEMS.filter((i) => inGroups.has(i.id))).toEqual([]);
    expect(inGroups.has(CHAT_CENTER_ITEM.id)).toBe(false);
  });
});

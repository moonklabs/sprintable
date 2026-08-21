import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spliceApiKey, splitRuntimeCapabilities, pickDefaultRuntime, groupAndFilterRoleTemplates, resolveKitFilename, resolveVerifyGuideKey } from './recruiter-client';
import type { McpConfigBundle, RuntimeCapabilityItem, RoleTemplateSummary } from '@/services/recruit';
import { RUNTIME_CAPABILITIES_FALLBACK, KIT_FILENAME } from '@/services/recruit';
import enMessages from '../../../../../../messages/en.json';
import koMessages from '../../../../../../messages/ko.json';

describe('spliceApiKey (까심 QA RC HIGH① — transport별 키 위치)', () => {
  it('replaces the key in headers.Authorization for the http (hosted) shape', () => {
    const bundle: McpConfigBundle = {
      mcpServers: { 'sprintable-mcp': { type: 'http', url: 'https://mcp.sprintable.ai/mcp', headers: { Authorization: 'Bearer sk_live_old', 'X-Project-Id': 'p1' } } },
    };
    const result = spliceApiKey(bundle, 'sk_live_new');
    expect(result?.mcpServers['sprintable-mcp'].headers?.Authorization).toBe('Bearer sk_live_new');
    expect(result?.mcpServers['sprintable-mcp'].headers?.['X-Project-Id']).toBe('p1'); // 다른 필드 보존
  });

  it('replaces the key in env.AGENT_API_KEY for the stdio (local) shape — the bug 까심 caught', () => {
    const bundle: McpConfigBundle = {
      mcpServers: { 'sprintable-mcp': { type: 'stdio', command: 'uvx', args: ['sprintable-mcp'], env: { SPRINTABLE_API_URL: 'https://api.example.com', AGENT_API_KEY: 'sk_live_old' } } },
    };
    const result = spliceApiKey(bundle, 'sk_live_new');
    expect(result?.mcpServers['sprintable-mcp'].env?.AGENT_API_KEY).toBe('sk_live_new');
    expect(result?.mcpServers['sprintable-mcp'].env?.SPRINTABLE_API_URL).toBe('https://api.example.com'); // 다른 필드 보존
  });

  it('returns null (never silently stale) when neither key location is present', () => {
    const bundle: McpConfigBundle = { mcpServers: { 'sprintable-mcp': { type: 'stdio', command: 'uvx' } } };
    expect(spliceApiKey(bundle, 'sk_live_new')).toBeNull();
  });
});

// E-RECRUIT S6 — 디디 BE PR #1911(`GET /api/v2/runtime-capabilities`) 착지 후 실제 계약으로 정정.
// 착수 시점에 전달받은 요약(`transport`3값 리터럴·`guide_filename`이 일반 필드)과 실제 스키마가
// 달라(connector도 정식 레지스트리 slug·지침파일=`prompt_file`) PR diff를 직접 읽고 타입을 맞췄다.
// 아래 REAL_BE_RESPONSE는 PR #1911 브랜치를 로컬 uvicorn(포트 8001, 기존 공유 로컬 Postgres 재사용)
// 으로 직접 띄워 curl로 받은 실 응답 그대로(2026-07-06) — 추측이 아니라 실측 고정.

/** BE PR #1911 실측 계약 기준 최소 필드 채움 헬퍼 — 테스트에서 관심 없는 필드는 디폴트로. */
function mkCap(overrides: Partial<RuntimeCapabilityItem> & Pick<RuntimeCapabilityItem, 'slug' | 'display_name' | 'supported'>): RuntimeCapabilityItem {
  return {
    tier: null, transport: null, mcp_transport: [], prompt_file: null, guide_filename: null,
    supports_event_push: false, icon: null,
    ...overrides,
  };
}

describe('splitRuntimeCapabilities (E-RECRUIT S6)', () => {
  it('splits the fallback into all 10 supported + 0 coming-soon (전 런타임 올지원, story 6f6ac081)', () => {
    const { supported, comingSoon } = splitRuntimeCapabilities(RUNTIME_CAPABILITIES_FALLBACK);
    expect(supported.map((r) => r.slug)).toEqual([
      'claude-code', 'codex', 'connector', 'cursor', 'gemini',
      'grok', 'hermes', 'openclaw', 'opencode', 'pi',
    ]);
    expect(comingSoon).toEqual([]);
  });

  it('splits a real BE response (PR #1911) with multiple supported runtimes, incl. connector as a normal entry', () => {
    const mock: RuntimeCapabilityItem[] = [
      mkCap({ slug: 'claude-code', display_name: 'Claude Code', supported: true, tier: 'full', prompt_file: 'CLAUDE.md' }),
      mkCap({ slug: 'connector', display_name: 'Connector', supported: true, tier: 'experimental', guide_filename: 'CONNECTOR_SETUP.md' }),
      mkCap({ slug: 'opencode', display_name: 'OpenCode', supported: false }),
    ];
    const { supported, comingSoon } = splitRuntimeCapabilities(mock);
    expect(supported.map((r) => r.slug)).toEqual(['claude-code', 'connector']);
    expect(comingSoon.map((r) => r.slug)).toEqual(['opencode']);
  });

  it('handles an empty registry (defensive — should never actually happen given the fallback)', () => {
    expect(splitRuntimeCapabilities([])).toEqual({ supported: [], comingSoon: [] });
  });
});

describe('pickDefaultRuntime (E-RECRUIT S6 — avoids recruit() 400 on an unsupported default)', () => {
  const supported: RuntimeCapabilityItem[] = [
    mkCap({ slug: 'claude-code', display_name: 'Claude Code', supported: true, tier: 'full', prompt_file: 'CLAUDE.md' }),
    mkCap({ slug: 'connector', display_name: 'Connector', supported: true, tier: 'experimental', guide_filename: 'CONNECTOR_SETUP.md' }),
  ];

  it('keeps the current selection when it is still in the supported list', () => {
    expect(pickDefaultRuntime(supported, 'connector')).toBe('connector');
  });

  it('falls back to the first supported runtime when the current selection is not supported', () => {
    // e.g. the default 'claude-code' state got orphaned because the registry no longer lists it first,
    // or a stale selection from a previous fetch is no longer present.
    expect(pickDefaultRuntime(supported, 'gemini')).toBe('claude-code');
  });

  it('leaves the current value untouched when the supported list is empty (defensive, never crashes)', () => {
    expect(pickDefaultRuntime([], 'claude-code')).toBe('claude-code');
  });
});

describe('resolveKitFilename (identity-overwrite regression guard — 까심 QA RC, 2026-07-08)', () => {
  // 정체성 덮어쓰기 버그(recruit-output-kit-redesign-crux §0): STEP4 다운로드 파일명이 런타임의
  // 진짜 정체성 파일명(prompt_file — CLAUDE.md/AGENTS.md/GEMINI.md)을 그대로 쓰면, 유저가 저장 시
  // 자기 에이전트 정체성 파일을 덮어쓴다. BE #1967이 사후 재발급 엔드포인트만 고치고 이 위저드는
  // 놓쳐 한 번 조용히 재발했다 — 이 테스트가 세 번째 재발을 막는다.
  const identityFilenamesByRuntime: RuntimeCapabilityItem[] = [
    mkCap({ slug: 'claude-code', display_name: 'Claude Code', supported: true, prompt_file: 'CLAUDE.md' }),
    mkCap({ slug: 'codex', display_name: 'Codex', supported: true, prompt_file: 'AGENTS.md' }),
    mkCap({ slug: 'gemini', display_name: 'Gemini', supported: true, prompt_file: 'GEMINI.md' }),
    mkCap({ slug: 'cursor', display_name: 'Cursor', supported: true, prompt_file: 'AGENTS.md' }),
  ];

  it.each(identityFilenamesByRuntime.map((rc) => [rc.slug, rc.prompt_file] as const))(
    'stays KIT_FILENAME for %s even though runtime-capabilities carries a real identity filename (%s)',
    (slug) => {
      expect(resolveKitFilename(slug, identityFilenamesByRuntime)).toBe(KIT_FILENAME);
    },
  );

  it('never falls back to a runtime-literal filename when runtimeCapabilities is null/loading', () => {
    expect(resolveKitFilename('claude-code', null)).toBe(KIT_FILENAME);
  });

  it('KIT_FILENAME itself does not collide with any known runtime identity filename', () => {
    const identityFilenames = new Set(identityFilenamesByRuntime.map((rc) => rc.prompt_file));
    expect(identityFilenames.has(KIT_FILENAME)).toBe(false);
  });
});

// 전 런타임 올지원(story 6f6ac081, 문서 `runtime-full-support-firstclass-crux`, PO GO
// 2026-07-08) 후 기대 계약(BE `list_runtime_capabilities()` SSOT와 동기화, 순서는 BE가 slug
// 알파벳순 정렬해 반환하는 그대로 보존). 이 고정값이 실제로 바뀌면 계약 드리프트니 이 테스트가
// 먼저 깨져야 한다(회귀 가드) — 배포 후 라이브 curl로 재확認 예정(디디).
const REAL_BE_RESPONSE: RuntimeCapabilityItem[] = [
  { slug: 'claude-code', display_name: 'Claude Code', supported: true, tier: 'full', transport: 'stdio', mcp_transport: ['http', 'stdio'], prompt_file: 'CLAUDE.md', guide_filename: null, supports_event_push: true, icon: null },
  { slug: 'codex', display_name: 'Codex', supported: true, tier: 'full', transport: 'stdio', mcp_transport: ['http', 'stdio'], prompt_file: 'AGENTS.md', guide_filename: null, supports_event_push: true, icon: null },
  { slug: 'connector', display_name: 'Connector', supported: true, tier: 'experimental', transport: null, mcp_transport: [], prompt_file: 'AGENT_INSTRUCTIONS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
  { slug: 'cursor', display_name: 'Cursor', supported: true, tier: 'full', transport: 'stdio', mcp_transport: ['http', 'stdio'], prompt_file: 'AGENTS.md', guide_filename: null, supports_event_push: true, icon: null },
  { slug: 'gemini', display_name: 'Gemini', supported: true, tier: 'full', transport: 'stdio', mcp_transport: ['http', 'stdio'], prompt_file: 'GEMINI.md', guide_filename: null, supports_event_push: true, icon: null },
  { slug: 'grok', display_name: 'Grok', supported: true, tier: 'full', transport: null, mcp_transport: [], prompt_file: 'AGENTS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
  { slug: 'hermes', display_name: 'Hermes', supported: true, tier: 'full', transport: null, mcp_transport: [], prompt_file: 'AGENTS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
  { slug: 'openclaw', display_name: 'OpenClaw', supported: true, tier: 'full', transport: null, mcp_transport: [], prompt_file: 'AGENTS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
  { slug: 'opencode', display_name: 'OpenCode', supported: true, tier: 'full', transport: null, mcp_transport: [], prompt_file: 'AGENTS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
  { slug: 'pi', display_name: 'Pi', supported: true, tier: 'full', transport: null, mcp_transport: [], prompt_file: 'AGENTS.md', guide_filename: 'CONNECTOR_SETUP.md', supports_event_push: false, icon: null },
];

describe('E-RECRUIT S6 — against the expected GET /api/v2/runtime-capabilities response (전 런타임 올지원)', () => {
  it('splits into all 10 supported and 0 coming-soon', () => {
    const { supported, comingSoon } = splitRuntimeCapabilities(REAL_BE_RESPONSE);
    expect(supported.map((r) => r.slug)).toEqual([
      'claude-code', 'codex', 'connector', 'cursor', 'gemini',
      'grok', 'hermes', 'openclaw', 'opencode', 'pi',
    ]);
    expect(comingSoon).toEqual([]);
  });

  it('only connector is tier=experimental (badge); the other 9 are full (no badge)', () => {
    const { supported } = splitRuntimeCapabilities(REAL_BE_RESPONSE);
    const experimental = supported.filter((r) => r.tier === 'experimental').map((r) => r.slug);
    const full = supported.filter((r) => r.tier === 'full').map((r) => r.slug);
    expect(experimental).toEqual(['connector']);
    expect(full).toEqual([
      'claude-code', 'codex', 'cursor', 'gemini', 'grok', 'hermes', 'openclaw', 'opencode', 'pi',
    ]);
  });

  it('default runtime stays claude-code (already first + tier=full)', () => {
    const { supported } = splitRuntimeCapabilities(REAL_BE_RESPONSE);
    expect(pickDefaultRuntime(supported, 'claude-code')).toBe('claude-code');
  });

  it("guideFilename derivation source: prompt_file carries the real per-runtime filename, guide_filename is connector-routed-only", () => {
    const bySlug = Object.fromEntries(REAL_BE_RESPONSE.map((r) => [r.slug, r]));
    expect(bySlug['claude-code'].prompt_file).toBe('CLAUDE.md');
    // 전 런타임 올지원(story 6f6ac081) — codex는 이제 확정 매핑(AGENTS.md), generic fallback 아님.
    expect(bySlug['codex'].prompt_file).toBe('AGENTS.md');
    expect(bySlug['grok'].prompt_file).toBe('AGENTS.md'); // 커넥터 전용 5종도 확정 매핑
    expect(bySlug['connector'].guide_filename).toBe('CONNECTOR_SETUP.md');
    expect(bySlug['grok'].guide_filename).toBe('CONNECTOR_SETUP.md'); // 커넥터-라우팅이라 동일
    expect(bySlug['claude-code'].guide_filename).toBeNull(); // MCP-native는 안내파일 없음
  });
});

// E-RECRUIT 카탈로그 탐색성(선생님 피드백, 2026-07-07) — division 그루핑 + 검색.
function mkRole(overrides: Partial<RoleTemplateSummary> & Pick<RoleTemplateSummary, 'id' | 'slug' | 'name' | 'category'>): RoleTemplateSummary {
  return {
    description: null,
    default_tool_groups: [],
    is_builtin: true,
    tier: 'full',
    version: 1,
    division: null,
    emoji: null,
    ...overrides,
  };
}

describe('groupAndFilterRoleTemplates (E-RECRUIT 카탈로그 탐색성)', () => {
  const roles: RoleTemplateSummary[] = [
    mkRole({ id: '1', slug: 'fe-dev', name: 'Frontend Developer', category: 'frontend', division: 'Engineering', description: 'Builds UI' }),
    mkRole({ id: '2', slug: 'be-dev', name: 'Backend Developer', category: 'backend', division: 'Engineering' }),
    mkRole({ id: '3', slug: 'copywriter', name: 'Copywriter', category: 'marketing', division: 'Marketing', description: 'Writes ad copy' }),
    // division 없는 레거시 롤 — category로 폴백해야 함
    mkRole({ id: '4', slug: 'qa-tester', name: 'QA Tester', category: 'qa', division: null }),
  ];

  it('groups by division, falling back to category when division is null, preserving first-seen order', () => {
    const groups = groupAndFilterRoleTemplates(roles, '');
    expect(groups.map((g) => g.label)).toEqual(['Engineering', 'Marketing', 'qa']);
    expect(groups[0].roles.map((r) => r.slug)).toEqual(['fe-dev', 'be-dev']);
    expect(groups[2].roles.map((r) => r.slug)).toEqual(['qa-tester']);
  });

  it('filters case-insensitively across name/description/category/division', () => {
    expect(groupAndFilterRoleTemplates(roles, 'frontend').flatMap((g) => g.roles.map((r) => r.slug))).toEqual(['fe-dev']);
    expect(groupAndFilterRoleTemplates(roles, 'AD COPY').flatMap((g) => g.roles.map((r) => r.slug))).toEqual(['copywriter']); // description match
    expect(groupAndFilterRoleTemplates(roles, 'engineering').flatMap((g) => g.roles.map((r) => r.slug))).toEqual(['fe-dev', 'be-dev']); // division match
  });

  it('returns an empty group list (not a crash) when nothing matches', () => {
    expect(groupAndFilterRoleTemplates(roles, 'nonexistent-role-xyz')).toEqual([]);
  });

  it('handles an empty catalog', () => {
    expect(groupAndFilterRoleTemplates([], '')).toEqual([]);
  });
});

// story #2377 A-1(규격 v1.2 §2) — "kitOrientingTitle 이 다시 수를 박지 않는다"의 회귀가드.
// 예전엔 en="set up 2 things"/ko="2가지를 세팅하세요"였다 — 단계 축이 늘 때마다(예: 이번처럼
// ①연결 ②지침 두 단계가 ①②③ 세 단계로 늘어나는 날) 그 수가 다시 거짓이 되는 재발 구조였다.
// 이 테스트는 "숫자를 안 쓴다"는 «성질»을 재지 특정 문자열을 재지 않는다 — 카피가 나중에 또
// 바뀌어도(이 PR처럼) 「숫자가 없다」는 성질만 지키면 계속 통과해야 값이 있다.
describe('recruiter.kitOrientingTitle — story #2377 A-1(수 하드코딩 금지)', () => {
  it('contains no digit in either locale — the step count must never be spelled out in the copy', () => {
    const en = (enMessages as { recruiter: { kitOrientingTitle: string } }).recruiter.kitOrientingTitle;
    const ko = (koMessages as { recruiter: { kitOrientingTitle: string } }).recruiter.kitOrientingTitle;
    expect(en).not.toMatch(/\d/);
    expect(ko).not.toMatch(/\d/);
  });
});

// story #2377 §2·§4 — STEP4 오리엔팅 카드가 3단계(①연결·②깨우기·③지침)로 서고 §4 발견 가능성
// 링크(connect-guide.txt)가 실제로 화면에 있는지의 회귀가드. RecruiterClient는 역할 선택→
// 스코프→에이전트 생성→recruit() 다단 위저드라 이 컴포넌트 전체를 마운트하는 기존 테스트가
// 없다(이 파일의 나머지 테스트도 전부 export된 순수 함수만 잰다) — 여기서도 그 관례를 따르되,
// STEP4는 순수 함수로 안 빠져 있으므로 «소스 텍스트» 수준에서 잰다(verify-no-alpha-focus-ring.ts
// 류의 정적 스캔과 같은 성질 — 렌더된 DOM이 아니라 「그 문자열이 소스에 있는가」). 이것으로
// «렌더된다»까지 증명되진 않는다 — 그건 AC4가 요구하는 라이브 재확認의 몫이다.
describe('recruiter-client STEP4 — story #2377 §2(단계 셋)·§4(발견 가능성 링크) 소스 회귀가드', () => {
  const source = readFileSync(fileURLToPath(new URL('./recruiter-client.tsx', import.meta.url)), 'utf-8');

  it('links to connect-guide.txt from the STEP4 card — a screen link, not just a file that exists', () => {
    expect(source).toContain('href="/connect-guide.txt"');
  });

  it('renders three numbered steps (Connect·Wake up·Instructions), not the old two', () => {
    expect(source).toContain("t('kitOrientingConnectLabel')");
    expect(source).toContain("t('kitOrientingWakeLabel')");
    expect(source).toContain("t('kitOrientingGuideLabel')");
  });

  it('shows an explicit "not registered yet" fallback for the wake-up step instead of staying silent', () => {
    expect(source).toContain("t('kitOrientingWakeBodyUnknown')");
  });
});

// story #2792 design:changes(카디르 QA, 2026-08-02) — verifyGuideMcp가 transport 무관 항상
// "tool을 호출해야 검증이 완료된다"고 말했다(http만 사실). stdio는 세션 연결만으로 SSE ack가
// 자동 진행되므로 별개 문장(verifyGuideMcpStdio)이어야 한다 — 이 판정이 다시 안 갈리게 pin.
describe('resolveVerifyGuideKey — story #2792 (STEP5 안내문도 showVerifyExamplePrompt와 같은 축)', () => {
  it('no mcp_config → connector guide regardless of transport', () => {
    expect(resolveVerifyGuideKey(false, 'http')).toBe('verifyGuideConnector');
    expect(resolveVerifyGuideKey(false, null)).toBe('verifyGuideConnector');
  });

  it('mcp_config + http → the tool-call-completes-verification guide (accurate for heartbeat)', () => {
    expect(resolveVerifyGuideKey(true, 'http')).toBe('verifyGuideMcp');
  });

  it('mcp_config + stdio → the auto-completes-on-connect guide, not the tool-call one', () => {
    expect(resolveVerifyGuideKey(true, 'stdio')).toBe('verifyGuideMcpStdio');
  });

  it('both locales have the new key', () => {
    const en = (enMessages as { recruiter: Record<string, string> }).recruiter.verifyGuideMcpStdio;
    const ko = (koMessages as { recruiter: Record<string, string> }).recruiter.verifyGuideMcpStdio;
    expect(en).toBeTruthy();
    expect(ko).toBeTruthy();
  });
});

// story #2410 ③-1(유나 판정, 2026-08-02) — connect-step에만 있던 verifiedBanner(aria-live 성공
// 낭독)가 recruiter STEP5에는 없었다. 근거: ①같은 제품 안에서 왜 다른지가 코드 어디에도 안
// 적혀 있었다(누락이지 판단이 아니다) ②recruiter STEP5는 채용할 때마다(반복) 뜨는 화면이라
// connect-step(신규 가입 온보딩, 1회성)보다 없을 때의 대가가 크다. 소스 텍스트 수준으로
// pin(이 파일의 기존 관례 — 컴포넌트 전체 마운트 테스트가 없다).
describe('recruiter-client STEP5 — story #2410 ③-1(verifiedBanner)', () => {
  const source = readFileSync(fileURLToPath(new URL('./recruiter-client.tsx', import.meta.url)), 'utf-8');

  it('renders verifiedBanner with the same role/aria contract as connect-step (role=status aria-live=polite aria-atomic=true)', () => {
    const m = /role="status" aria-live="polite" aria-atomic="true"[^>]*>\s*\{tOnboarding\('verifiedBanner'\)\}/.exec(source);
    expect(m).not.toBeNull();
  });

  it('reuses the same i18n key as connect-step, not a recruiter-local one (single key per Yuna\'s judgment)', () => {
    expect(source).toContain("tOnboarding('verifiedBanner')");
    expect(source).not.toMatch(/t\('recruiterVerifiedBanner'\)|t\('verifiedBanner'\)/);
  });

  it('only renders when verified — does not duplicate the rail\'s own step-by-step aria-live announcements', () => {
    // {verified && ( ... verifiedBanner ... )} — gated, not unconditional.
    expect(source).toMatch(/\{verified && \([\s\S]{0,700}tOnboarding\('verifiedBanner'\)/);
  });
});

// story #4cdad425(prod 에스컬레이트) — 실유저가 탄 표면이 여기(채용 위저드 STEP5)였다(Backend Engineer
// 채용 1호). connect-step(#3114)에만 넣었던 검증 안내 3종(재시작·대기·타임아웃)을 이 표면에도 넣는다.
// 이 컴포넌트는 STEP5까지의 마운트가 불가한 거대 위저드라 소스 텍스트 수준으로 pin(이 파일의 기존 관례).
// 실제 렌더 로직(조건 ↔ 훅 출력 대응)은 connect-step.test.tsx가 DOM 마운트로 덮는다 — 같은 useVerificationRail·
// 같은 tOnboarding 키를 쓰므로 로직은 동일하고, 여기서는 «이 표면에 그 JSX가 실제로 있는가»를 지킨다.
describe('recruiter-client STEP5 — story #4cdad425 (검증 안내 3종: 재시작·대기·타임아웃)', () => {
  const source = readFileSync(fileURLToPath(new URL('./recruiter-client.tsx', import.meta.url)), 'utf-8');

  it('① 재시작 안내를 connect-step과 같은 onboarding 키로 렌더한다(설정 저장 후 Claude Code 재시작)', () => {
    expect(source).toContain("tOnboarding('restartAfterConfig')");
  });

  it('② 대기 표시는 awaitingVerification && !timedOut로 게이팅된다(폴링 중에만·verified/timeout이면 사라짐)', () => {
    expect(source).toMatch(/\{awaitingVerification && !timedOut && \([\s\S]{0,300}tOnboarding\('verifyWaiting'\)/);
  });

  it('③ 타임아웃 힌트는 timedOut으로 게이팅되고 제목+본문 두 키를 쓴다(진단 힌트)', () => {
    expect(source).toMatch(/\{timedOut && \([\s\S]{0,400}tOnboarding\('verifyTimeoutTitle'\)[\s\S]{0,250}tOnboarding\('verifyTimeoutHint'\)/);
  });

  it('대기와 타임아웃은 timedOut 한 축으로 상호배타된다(동시에 안 뜸)', () => {
    expect(source).toContain('awaitingVerification && !timedOut');
    expect(source).toMatch(/\{timedOut && \(/);
  });
});

// story #2433(A/B) — 미르코 실측(codex 표본, 2026-08-03): 위저드에서 런타임을 골라 채용해도
// 관리화면엔 "런타임 타입: 미설정"으로 떴다(A) + "역할 없이(키만)"는 실행환경(런타임) 단계
// 자체가 스킵됐다(B). 소스 텍스트 수준으로 pin(이 파일의 기존 관례 — 컴포넌트 전체 마운트
// 테스트가 없다). BE(recruit_agent → members.runtime_type anchor write)는
// backend/tests/test_e_recruit_s3_recruit_service_realdb.py::test_recruit_persists_runtime_type_to_member
// 가 실 Postgres로 커버한다(뮤테이션 셀프체크: 그 write 줄을 되돌려 RED 확認 후 복원).
describe('recruiter-client equip-skip("역할 없이") 런타임 — story #2433(B) 소스 회귀가드', () => {
  const source = readFileSync(fileURLToPath(new URL('./recruiter-client.tsx', import.meta.url)), 'utf-8');

  it('equip-skip 폼(STEP2)이 Full 경로 STEP3과 같은 renderRuntimePicker()를 렌더한다 — 스킵되지 않는다', () => {
    const start = source.indexOf('{equipSkip ? (');
    const end = source.indexOf(') : null}', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const equipBlock = source.slice(start, end);
    expect(equipBlock).toContain('{renderRuntimePicker()}');
  });

  it('Full 경로 STEP3도 같은 renderRuntimePicker() 호출로 통일됐다(그리드 마크업 중복 없음)', () => {
    const step3Block = /step === 3 && !equipSkip[\s\S]{0,200}?\{renderRuntimePicker\(\)\}/.exec(source);
    expect(step3Block).not.toBeNull();
  });

  it('handleEquipCreate가 생성 성공 직후 PATCH /api/team-members/{id}로 runtime_type을 반영한다(관리화면과 같은 anchor 경로)', () => {
    const handlerMatch = /const handleEquipCreate = async \(\) => \{[\s\S]*?\n  \};/.exec(source);
    expect(handlerMatch).not.toBeNull();
    const body = handlerMatch![0];
    expect(body).toContain('/api/team-members/${agentId}');
    expect(body).toContain("method: 'PATCH'");
    expect(body).toContain('runtime_type: runtime');
  });

  it('PATCH 실패해도 결과 화면을 막지 않되(키는 이미 유효) 반쪽 상태를 조용히 숨기지 않는다', () => {
    const handlerMatch = /const handleEquipCreate = async \(\) => \{[\s\S]*?\n  \};/.exec(source);
    const body = handlerMatch![0];
    expect(body).toContain('setEquipRuntimeSaveWarning(true)');
    expect(body).toContain('setStep(3)'); // PATCH 실패 분기에서도 결과 화면 진입은 유지
    expect(source).toContain("equipRuntimeSaveWarning && (");
    expect(source).toContain("t('equipRuntimeSaveWarning')");
  });

  it('equipRuntimeSaveWarning 번역키가 ko/en 둘 다 있다', () => {
    const en = (enMessages as { recruiter: Record<string, string> }).recruiter.equipRuntimeSaveWarning;
    const ko = (koMessages as { recruiter: Record<string, string> }).recruiter.equipRuntimeSaveWarning;
    expect(en).toBeTruthy();
    expect(ko).toBeTruthy();
  });
});

// story #2434(유나 홀름 규격 v1, 2026-08-03) — ②「깨우기」의 "connectors/{runtime}-sprintable/를
// 실행하세요" 같은 지시형은 그 경로를 어디서 구하는지 안내가 없는 채로 "되는 것"처럼 읽혀
// "되는 줄 알고 끝냈다가 실제로는 안 깨어나는" 오탐(최악)을 만든다. 사실형("…이 세션을
// 깨웁니다. 받는 경로는 아직 제공하지 않습니다")으로 정정 + path는 t.rich로 "명령 대상"이
// 아니라 "이름"으로 강등(작게·무채색·링크 색 금지) + 3칸 그리드 아래 전폭 결과 문장(경고색
// 금지 — 미제공이지 장애가 아니다) + connector-sdk(Custom/Other)만 실제로 지금 가능한 경로라
// onboarding-guide.txt 링크 추가. 소스 텍스트 수준으로 pin(이 파일의 기존 관례).
describe('recruiter-client STEP4 ②깨우기 — story #2434(정직한 "반쪽" 표시) 소스 회귀가드', () => {
  const source = readFileSync(fileURLToPath(new URL('./recruiter-client.tsx', import.meta.url)), 'utf-8');

  // 유나양 design:changes(2026-08-03) — 태그명이 ICU 인자명과 같으면(<path>{path}</path> +
  // path: (chunks)=>...) next-intl이 값을 조용히 삼킨다. 태그명(code)과 값 인자(path)를
  // 분리하는 규칙 자체는 소스로도 pin하되, "정말 렌더되는가"는 실 마운트
  // (recruiter-client.wake-method-body.test.tsx)가 권위다 — 이 테스트만으로 안전을 주장하지
  // 않는다(오늘 배운 것: 이름만 있는 가드는 자격이 없다).
  it('STEP4가 WakeMethodBody(별도 컴포넌트)로 렌더하고, 그 안에서 code 태그+별도 path 값으로 t.rich를 호출한다', () => {
    expect(source).toContain('<WakeMethodBody method={wakeInfo.method} path={wakeInfo.path} />');
    const fnMatch = /export function WakeMethodBody[\s\S]*?\n}/.exec(source);
    expect(fnMatch).not.toBeNull();
    const fn = fnMatch![0];
    expect(fn).toContain('t.rich(`kitOrientingWakeBody_${method}`');
    expect(fn).toContain('font-mono text-[11px] break-all text-muted-foreground');
    expect(fn).toMatch(/path,\s*\n\s*code: \(chunks\)/); // 태그명(code) ≠ 값 인자명(path)
    expect(fn).not.toMatch(/text-info|text-primary|underline/); // 링크 색 금지
  });

  it('3칸 그리드 밖에 전폭 결과 문장을 렌더하고, mcp_config 유무 분기를 재사용한다(신규 계약 0)', () => {
    const start = source.indexOf("{t('kitOrientingWakeLabel')}");
    const end = source.indexOf('kitOrientingWakeNoteConnector');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end + 'kitOrientingWakeNoteConnector'.length + 5);
    expect(block).toContain("recruitResult.mcp_config ? t('kitOrientingWakeNoteMcp') : t('kitOrientingWakeNoteConnector')");
  });

  it('결과 문장에 warning/destructive 색을 안 쓴다 — 미제공이지 장애가 아니라서 오탐(자기 설정이 틀렸다는 오해)을 막는다', () => {
    const start = source.indexOf('{recruitResult.mcp_config ? t(\'kitOrientingWakeNoteMcp\')');
    const line = source.slice(Math.max(0, start - 200), start);
    expect(line).not.toMatch(/warning|destructive/);
  });

  it('connector-sdk(Custom/Other)에서만 onboarding-guide.txt 링크를 추가로 보여준다', () => {
    expect(source).toContain("wakeInfo.method === 'connector-sdk'");
    expect(source).toContain('href="/onboarding-guide.txt"');
  });

  it('kitOrientingWakeBody_* / WakeNote* / WakeSdkGuideLink 번역키가 ko/en 둘 다 있다', () => {
    const ko = (koMessages as { recruiter: Record<string, string> }).recruiter;
    const en = (enMessages as { recruiter: Record<string, string> }).recruiter;
    for (const key of [
      'kitOrientingWakeBody_channel-plugin',
      'kitOrientingWakeBody_connector-host',
      'kitOrientingWakeBody_connector-sidecar',
      'kitOrientingWakeBody_connector-sdk',
      'kitOrientingWakeNoteMcp',
      'kitOrientingWakeNoteConnector',
      'kitOrientingWakeSdkGuideLink',
    ]) {
      expect(ko[key], `ko.${key}`).toBeTruthy();
      expect(en[key], `en.${key}`).toBeTruthy();
      // story #2652(유나 design 게이트 소견, 2026-08-14) — #2648 Part1에서 channel-plugin만
      // 비-actionable path 노출이 빠졌던 것을 형제 3종(connector-host/sidecar/sdk)까지
      // 마저 통일: kitOrientingWakeBody_* 4종 전부 <code>(path 노출) 없이 같은 구조로
      // "받는 경로는 아직 제공하지 않습니다"만 말한다. WakeMethodBody의 path/code t.rich
      // 인자 자체는 남겨둔다(메시지가 <code>를 다시 쓰게 되면 즉시 값이 채워지도록) —
      // recruiter-client.wake-method-body.test.tsx가 실 렌더로 무노출을 재확인한다.
      if (key.startsWith('kitOrientingWakeBody_')) {
        expect(ko[key], `ko.${key}`).not.toContain('<code>');
        expect(en[key], `en.${key}`).not.toContain('<code>');
        expect(ko[key], `ko.${key}`).not.toContain('{path}');
        expect(en[key], `en.${key}`).not.toContain('{path}');
      }
      if (key === 'kitOrientingWakeBody_channel-plugin') {
        expect(ko[key]).not.toContain('fakechat');
        expect(en[key]).not.toContain('fakechat');
      }
    }
  });
});

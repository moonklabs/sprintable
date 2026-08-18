// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import {
  parseVerificationRail, VerifyRail, computeRailStageLabel, computeShowVerifyExamplePrompt,
  useVerificationRail, VERIFY_TIMEOUT_MS,
  type DisplayStep,
} from './verify-rail';
import ko from '../../../messages/ko.json';

// story #2415(2026-08-02, 라이브 재확認 중 발견) — recruiter-client.tsx·connect-step.tsx가
// 각자 `json.data.steps`를 읽었는데, 백엔드(`GET /agents/{id}/verification-status`)의 실제
// 필드명은 `rail`이다. `steps`는 항상 undefined였으므로 검증이 실제로 성공해도 화면 레일은
// 초기 pending에서 한 번도 안 움직였다 — curl로 직접 확認한 실 응답 형태 그대로 고정한다.
describe('parseVerificationRail — story #2415 (steps→rail 필드명 회귀 고정)', () => {
  it('parses the real backend shape ({data:{rail:[...]}}) — this is the exact response captured live via curl', () => {
    const realResponse = {
      data: {
        agent_id: '381276fa-ba35-432a-b5a6-9feadc6c9b03',
        verification_seq: null,
        verified: true,
        rail: [
          { state: 'config_copied', status: 'done' },
          { state: 'waiting', status: 'done' },
          { state: 'mcp_reachable', status: 'done' },
          { state: 'verified', status: 'done' },
        ],
      },
      error: null,
      meta: null,
    };
    expect(parseVerificationRail(realResponse)).toEqual([
      { state: 'config_copied', status: 'done' },
      { state: 'waiting', status: 'done' },
      { state: 'mcp_reachable', status: 'done' },
      { state: 'verified', status: 'done' },
    ]);
  });

  it('regression: a `steps` field (the bug this replaces) is NOT read as rail data', () => {
    // 이전 버그의 정확한 재현 — `steps`라는 필드는 백엔드에 존재한 적이 없다. 이 필드가
    // 있어도(다른 소비처의 실수·구버전 mock 등) 그것을 rail로 오인해서는 안 된다.
    const responseWithWrongFieldName = {
      data: { verified: true, steps: [{ state: 'verified', status: 'done' }] },
    };
    expect(parseVerificationRail(responseWithWrongFieldName)).toBeNull();
  });

  it('returns null (not a crash, not stale data) on malformed/empty responses', () => {
    expect(parseVerificationRail(null)).toBeNull();
    expect(parseVerificationRail(undefined)).toBeNull();
    expect(parseVerificationRail({})).toBeNull();
    expect(parseVerificationRail({ data: {} })).toBeNull();
    expect(parseVerificationRail('not an object')).toBeNull();
  });

  it('also accepts a bare top-level rail (defensive — matches the pre-existing fallback shape)', () => {
    const bareShape = { rail: [{ state: 'config_copied', status: 'done' }] };
    expect(parseVerificationRail(bareShape)).toEqual([{ state: 'config_copied', status: 'done' }]);
  });

  it('also accepts data itself being the array (defensive — matches the pre-existing fallback shape)', () => {
    const dataIsArray = { data: [{ state: 'config_copied', status: 'done' }] };
    expect(parseVerificationRail(dataIsArray)).toEqual([{ state: 'config_copied', status: 'done' }]);
  });
});

function render(steps: DisplayStep[]) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <VerifyRail steps={steps} />
    </NextIntlClientProvider>,
  );
}

function step(overrides: Partial<DisplayStep>): DisplayStep {
  return { state: 'mcp_reachable', status: 'done', label: '테스트 단계', ...overrides };
}

// story #2418 — BE는 지금 어떤 rail 단계에도 status:"failed"를 내지 않는다(backend/app/
// services/agent_verify.py::build_verification_rail/build_http_verification_rail 전수 확認 —
// 만드는 값은 pending/active/done뿐, reason 필드 자체가 없다). 즉 지금은 "reason이 가끔
// 빈다"가 아니라 "이 분기가 아직 한 번도 실행된 적 없는 죽은 경로"다 — 그래도 미래에 failed가
// 생기면 그 순간 이 자리가 처음 뜨므로, reason 없이 침묵하지 않도록 방어적으로 fallback을
// 세운다(모르는 것을 모른다고 말하는 편이 침묵보다 낫다).
describe('VerifyRail — story #2418 (failed인데 reason이 없으면 침묵하지 않는다)', () => {
  it('reason이 있으면 그 reason 그대로 보여준다', () => {
    const markup = render([step({ status: 'failed', reason: 'MCP 서버에 연결할 수 없습니다' })]);
    expect(markup).toContain('MCP 서버에 연결할 수 없습니다');
    expect(markup).not.toContain('왜인지 서버가 말해주지 않았습니다');
  });

  it('실측된 결함 재현 — failed인데 reason이 없으면(현재 BE 실제 형태) fallback 문구가 뜬다', () => {
    const markup = render([step({ status: 'failed', reason: undefined })]);
    expect(markup).toContain('왜인지 서버가 말해주지 않았습니다');
  });

  it('음성대조 — done/pending/active엔 fallback 문구가 뜨지 않는다', () => {
    for (const status of ['done', 'pending', 'active'] as const) {
      const markup = render([step({ status, reason: undefined })]);
      expect(markup).not.toContain('왜인지 서버가 말해주지 않았습니다');
    }
  });
});

// story #2419(유나 규격·PO 승인) — text-destructive는 bg-destructive/10 박스 위에서 3.97
// (AA 4.5 미달, apps/web/src/lib/color-contrast.test.ts에서 실측 고정). story #2420 v3 —
// 계열별 토큰(destructive-on-subtle) 대신 규칙 하나로: tint 배경 위 글자는 text-foreground
// (destructive on tint: light 16.72·dark 15.58, 정의 시점 검증은
// scripts/verify-tint-foreground-contrast.ts). --foreground 자체가 테마마다 값을 가지므로
// dark: 짝이 따로 필요 없다.
describe('VerifyRail — story #2419/#2420 (실패 사유 박스 텍스트 대비)', () => {
  it('실패 사유 박스는 text-foreground를 쓰고, 계열색(text-destructive*, 대비 미달 조합)은 안 쓴다', () => {
    const markup = render([step({ status: 'failed', reason: '사유' })]);
    const classAttr = markup.match(/<div class="([^"]*)">사유<\/div>/)?.[1];
    expect(classAttr).toBeDefined();
    const classes = classAttr!.split(/\s+/);
    expect(classes).toContain('text-foreground');
    expect(classes).not.toContain('text-destructive');
    expect(classes).not.toContain('text-destructive-on-subtle');
  });
});

// story #2407 — recruiter-client.tsx·connect-step.tsx가 검증 레일 상태파생·폴링·핸들러를
// 각자 재구현하던 것을 useVerificationRail 하나로 모으면서, 근거 없이 갈려 있던 두 지점을
// connect-step의 (기술적으로 더 정확한) 쪽으로 통일했다 — recruiter 쪽 동작이 실제로 바뀌는
// 자리라 "판정이 아니라 실패하는 assert"로 고정한다(#2178 자).
describe('computeRailStageLabel — story #2407 ②-3 (transport 무관 항상 채워짐)', () => {
  const t = (key: 'railStageHosted' | 'railStageLocal') =>
    key === 'railStageHosted' ? '호스팅 · 4단계' : '로컬 · 6단계';

  it('http → 호스팅 라벨', () => {
    expect(computeRailStageLabel('http', t)).toBe('호스팅 · 4단계');
  });

  it('stdio → 로컬 라벨(예전 recruiter는 여기서 빈 문자열이었다 — 그 회귀를 막는 자리)', () => {
    expect(computeRailStageLabel('stdio', t)).toBe('로컬 · 6단계');
  });

  it('transport 미해소(null) → 로컬 라벨로 폴백(connect-step 기존 동작 그대로 보존)', () => {
    expect(computeRailStageLabel(null, t)).toBe('로컬 · 6단계');
  });
});

describe('computeShowVerifyExamplePrompt — story #2407 ②-4 (http에서만 인과적으로 정확)', () => {
  it('http·미검증 → 노출', () => {
    expect(computeShowVerifyExamplePrompt('http', false)).toBe(true);
  });

  it('http·검증완료 → 비노출', () => {
    expect(computeShowVerifyExamplePrompt('http', true)).toBe(false);
  });

  it('stdio·미검증 → 비노출(예전 recruiter는 여기서 노출했다 — heartbeat 없는 축이라 부정확한 안내였다)', () => {
    expect(computeShowVerifyExamplePrompt('stdio', false)).toBe(false);
  });

  it('transport 미해소(null) → 비노출', () => {
    expect(computeShowVerifyExamplePrompt(null, false)).toBe(false);
  });
});

// story #4cdad425(prod 에스컬레이트) — 설정만 붙이고 Claude Code 재시작 안 하면 검증이 영원히
// pending에 머물러 실유저가 5회 재시도했다(무한 폴링 가림). 폴링 중엔 «확인 중»을, 타임아웃 뒤엔
// «진단 힌트»를 띄우는 상태 신호(awaitingVerification·timedOut)를 고정한다.
describe('useVerificationRail — story #4cdad425 (검증 타임아웃 진단 상태)', () => {
  const opts = { agentId: 'a1', transport: 'http' as const, enabled: true, configCopiedDone: false };

  // 코드베이스 마운트 패턴(createRoot + React.act·@testing-library 미설치). 훅 결과를 DOM에 렌더해
  // 관측한다(아웃터 변수 변경 없이 — react-hooks/immutability 준수).
  function Harness({ o }: { o: Parameters<typeof useVerificationRail>[0] }) {
    const rail = useVerificationRail(o);
    return (
      <div>
        <span data-testid="awaiting">{String(rail.awaitingVerification)}</span>
        <span data-testid="timedout">{String(rail.timedOut)}</span>
        <button type="button" data-testid="retry" onClick={() => { void rail.handleVerify(); }}>retry</button>
      </div>
    );
  }
  function mount(o: Parameters<typeof useVerificationRail>[0]) {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul"><Harness o={o} /></NextIntlClientProvider>,
      );
    });
    const read = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent;
    return { container, read, unmount: () => act(() => root.unmount()) };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // 절대 verified로 안 넘어가는 폴 응답(pending 유지) — 재시작 안 한 실유저 상황.
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('폴링 중(verified 전)엔 awaitingVerification=true·timedOut=false', () => {
    const { read, unmount } = mount(opts);
    expect(read('awaiting')).toBe('true');
    expect(read('timedout')).toBe('false');
    unmount();
  });

  it('VERIFY_TIMEOUT_MS 지나도 verified 안 되면 timedOut=true(진단 힌트 트리거)', () => {
    const { read, unmount } = mount(opts);
    act(() => { vi.advanceTimersByTime(VERIFY_TIMEOUT_MS + 100); });
    expect(read('timedout')).toBe('true');
    unmount();
  });

  it('handleVerify(수동 재시도)는 timedOut을 리셋한다(타이머 재무장)', async () => {
    const { container, read, unmount } = mount(opts);
    act(() => { vi.advanceTimersByTime(VERIFY_TIMEOUT_MS + 100); });
    expect(read('timedout')).toBe('true');
    const btn = container.querySelector('[data-testid="retry"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(read('timedout')).toBe('false');
    unmount();
  });

  it('enabled=false면 폴링·타임아웃 없음(awaitingVerification=false·timedOut=false)', () => {
    const { read, unmount } = mount({ ...opts, enabled: false });
    act(() => { vi.advanceTimersByTime(VERIFY_TIMEOUT_MS + 100); });
    expect(read('awaiting')).toBe('false');
    expect(read('timedout')).toBe('false');
    unmount();
  });
});

// story #2467 respec — SSE push가 재조회를 "트리거"하는 것이지 타이머가 반복 도는 게 아님을
// 직접 증명한다. useSseNotifications를 모킹해 onExtraEvent 콜백을 손으로 쥐고 실행 —
// 그 호출 하나가 fetch 1회를 유발하는지, 그리고 시간 경과만으로는(콜백 없이) fetch가 안
// 늘어나는지(=반복 타이머 부재) 둘 다 확인한다.
vi.mock('@/hooks/use-sse-notifications', () => ({
  useSseNotifications: vi.fn(),
}));

describe('useVerificationRail — story #2467 respec (SSE push가 재조회를 트리거·polling 아님)', () => {
  const opts = { agentId: 'a1', transport: 'stdio' as const, enabled: true, configCopiedDone: false };

  beforeEach(() => {
    vi.useFakeTimers();
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('시간만 흘러선 재조회가 안 늘어난다(반복 타이머 없음) — SSE push가 와야 늘어난다', async () => {
    const { useSseNotifications } = await import('@/hooks/use-sse-notifications');
    let capturedOnExtraEvent: ((eventName: string, data: unknown) => void) | undefined;
    (useSseNotifications as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (o: { onExtraEvent?: typeof capturedOnExtraEvent }) => { capturedOnExtraEvent = o.onExtraEvent; },
    );

    function Harness2({ o }: { o: Parameters<typeof useVerificationRail>[0] }) {
      useVerificationRail(o);
      return null;
    }
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul"><Harness2 o={opts} /></NextIntlClientProvider>,
      );
    });

    const callsAfterMount = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0); // 마운트 1회 스냅샷

    // 시간만 30초 흘려도(과거 2.5s 폴링이면 12번 더 늘었을 시간) 추가 fetch 없음.
    act(() => { vi.advanceTimersByTime(30_000); });
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterMount);

    // SSE push 도착(mock onExtraEvent 직접 호출) → 그 즉시 단발 재조회 1회.
    act(() => { capturedOnExtraEvent?.('onboarding.rail_signal', { agent_id: 'a1', state: 'mcp_reachable' }); });
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterMount + 1);

    // 다른 agent_id의 신호는 무시(내 재조회 트리거 아님).
    act(() => { capturedOnExtraEvent?.('onboarding.rail_signal', { agent_id: 'someone-else', state: 'verified' }); });
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterMount + 1);

    act(() => root.unmount());
  });
});

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, X, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

import { fetchWithAuth } from '@/lib/db/client';
import { useSseNotifications } from '@/hooks/use-sse-notifications';

export type RailStatus = 'pending' | 'active' | 'done' | 'failed';

/** E-MCP-OPT S3: SaaS 기본=호스팅(http)·OSS 기본=로컬(stdio) — BE `default_transport_for_edition()`
 * 따름. story #2407 — 원래 connect-step.tsx 소유였다가 이 파일(검증 레일 공용 축)로 옮겼다(② -5:
 * useVerificationRail이 transport를 직접 다루므로 타입도 여기가 자연스러운 자리). */
export type Transport = 'http' | 'stdio';

/** OB-2 verification-status 권위 state 키 (1:1·2026-06-25 락). 한글 라벨은 display-only. */
export const RAIL_ORDER = [
  'config_copied',
  'waiting',
  'mcp_reachable',
  'event_delivered',
  'ack',
  'verified',
] as const;

export type RailState = (typeof RAIL_ORDER)[number];

/** E-MCP-OPT S3: 호스팅(http) transport 축소 레일 — event_delivered/ack 없음(구조적으로 불가·BE agent_verify.py). */
export const HTTP_RAIL_ORDER = ['config_copied', 'waiting', 'mcp_reachable', 'verified'] as const;

/** story #2467 respec(2026-08-18, 「10초 내 살아있음 신호」 의무) — 원래 60s(story #4cdad425
 * polling 진단힌트)였으나, 신호 의무 프로토콜로는 연결 직후 10초가 "살아있다는 첫 신호"의
 * 상한이다(재실측 #2748: 순수 왕복 6.5초 — 10초는 그 위 여유). 10초 안에 mcp_reachable/verified
 * SSE push가 안 오면 «미도달 + 진단 힌트»를 정직히 띄운다(#2404 클래스 재발 방지 — 침묵을
 * "대기 중"으로 영원히 두지 않음). SSE push는 늦게라도 도착하면 이 힌트를 자동으로 감춘다. */
export const VERIFY_TIMEOUT_MS = 10_000;

export interface DisplayStep {
  state: RailState;
  status: RailStatus;
  label: string;
  reason?: string;
}

/** BE `GET /agents/{id}/verification-status` 응답의 한 단계 원본(라벨 미부여). */
export interface RawStep {
  state: RailState;
  status: RailStatus;
  reason?: string;
}

// story #2407 — connect-step.tsx·recruiter-client.tsx가 문자 그대로 복제하던 상수. useVerificationRail의
// displaySteps 계산이 여기 있으므로 상수도 같은 자리로.
const RAIL_LABEL_KEY: Record<RailState, string> = {
  config_copied: 'railConfigCopied',
  waiting: 'railWaiting',
  mcp_reachable: 'railMcpReachable',
  event_delivered: 'railEventDelivered',
  ack: 'railAck',
  verified: 'railVerified',
};

/**
 * story #2404 후속(2026-08-02, 라이브 재확認 중 발견) — recruiter-client.tsx와
 * onboarding/connect-step.tsx가 각자 이 파싱을 따로 구현했는데, 둘 다 `json.data.steps`를
 * 읽고 있었다. 백엔드(`backend/app/routers/agents.py::agent_verification_status`)는 그런
 * 필드를 준 적이 없다 — 실제 필드명은 `rail`이다(`{"data":{"verified":true,"rail":[...]}}`).
 * `steps`는 항상 undefined였으므로 이 파싱은 «단 한 번도» 실 데이터를 낸 적이 없었다 —
 * 검증이 실제로 성공해도(curl로 직접 확認: verified:true) 화면 레일은 초기 pending에
 * 멈춰 있었다. 두 파일이 같은 파싱을 각자 구현하고 있었던 것 자체가 이 버그가 두 곳에서
 * 동시에 존재하게 된 이유이므로, 여기 하나로 모아 그 재발 경로를 없앤다.
 */
export function parseVerificationRail(json: unknown): RawStep[] | null {
  if (json === null || typeof json !== 'object') return null;
  const data = (json as { data?: unknown }).data;
  const rail = Array.isArray(data)
    ? data
    : (data as { rail?: unknown } | undefined)?.rail ?? (json as { rail?: unknown }).rail;
  return Array.isArray(rail) ? (rail as RawStep[]) : null;
}

function StepIcon({ status }: { status: RailStatus }) {
  if (status === 'done') {
    return (
      <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-success text-white">
        <Check className="h-3.5 w-3.5" aria-hidden />
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-destructive text-white">
        <X className="h-3.5 w-3.5" aria-hidden />
      </span>
    );
  }
  if (status === 'active') {
    // active = status 토큰 `info`(진행중)로 spectrum 완성: muted(대기)→info(진행중)→success(완료)/destructive(실패).
    return (
      <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-info text-info">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      </span>
    );
  }
  return (
    <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full border-2 border-dashed border-border" aria-hidden />
  );
}

export function VerifyRail({ steps }: { steps: DisplayStep[] }) {
  // story #2418 — BE는 현재 어떤 rail 단계에도 status:"failed"를 내지 않는다(전수 확認:
  // build_verification_rail/build_http_verification_rail이 만드는 값은 pending/active/done
  // 뿐이고 reason 필드 자체가 없다). 즉 지금은 「reason이 가끔 빈다」가 아니라 「이 분기가
  // 아직 한 번도 실행된 적이 없는 죽은 경로」다 — 그래도 미래에(타임아웃 등) failed가 생기면
  // 그 순간 이 자리가 처음 뜨는데, reason 없이 침묵하면 #2415 이전과 같은 병(상태를 못
  // 말하는 화면)이 재발한다. 방어적으로 지금 fallback을 세운다.
  const t = useTranslations('onboarding');
  const activeStep = steps.find((s) => s.status === 'active');
  const failedStep = steps.find((s) => s.status === 'failed');
  const announce = failedStep?.label ?? activeStep?.label ?? '';

  return (
    <>
      <ol className="relative">
        {steps.map((step, i) => {
          const isLast = i === steps.length - 1;
          const statusText =
            step.status === 'done'
              ? '완료'
              : step.status === 'active'
                ? '진행 중'
                : step.status === 'failed'
                  ? '실패'
                  : '대기';
          return (
            <li
              key={step.state}
              className={cn('relative flex gap-3', !isLast && 'pb-5')}
              aria-current={step.status === 'active' ? 'step' : undefined}
            >
              {!isLast && (
                <span
                  aria-hidden
                  className={cn(
                    'absolute left-[10px] top-6 bottom-0 w-0.5',
                    step.status === 'done' ? 'bg-success' : 'bg-border',
                  )}
                />
              )}
              <span className="relative z-10 mt-0.5 shrink-0">
                <StepIcon status={step.status} />
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <p
                  className={cn(
                    'text-sm',
                    step.status === 'done' && 'text-foreground',
                    step.status === 'active' && 'font-medium text-foreground',
                    step.status === 'failed' && 'font-medium text-destructive',
                    step.status === 'pending' && 'text-muted-foreground',
                  )}
                >
                  {step.label}
                  <span className="sr-only"> — {statusText}</span>
                </p>
                {step.status === 'failed' && (
                  // story #2419(유나 규격) — text-destructive는 이 옅은 bg-destructive/10 박스
                  // 위에서 3.97(AA 미달)이었다. story #2420 v3 — 계열색 대신 text-foreground
                  // 하나로(destructive on tint: light 16.72·dark 15.58, 정의 시점 검증은
                  // scripts/verify-tint-foreground-contrast.ts). dark: 짝은 안 붙인다 —
                  // --foreground 자체가 테마마다 값을 가져 이 클래스 하나로 양쪽 다 안전하다.
                  <div className="mt-1.5 rounded-md border border-destructive/20 bg-destructive/10 px-2.5 py-2 text-xs text-foreground">
                    {/* story #2418 — reason 없이 침묵하지 않는다(#2415 이전과 같은 "화면이
                        상태를 못 말하는" 병). BE가 실제로 reason을 못 줄 때만 뜬다(음성대조:
                        done/pending/active엔 이 블록 자체가 없다). */}
                    {step.reason ?? t('verifyReasonUnknown')}
                  </div>
                )}
                {step.status !== 'failed' && step.reason && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{step.reason}</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
    </>
  );
}

/** BE `GET /agents/{id}/verification-status` 원 응답(라벨 미부여) — pollStatus fetch 결과. */
export interface UseVerificationRailOptions {
  agentId: string | null | undefined;
  transport: Transport | null;
  /** 폴링을 시작할지 — connect-step: `Boolean(apiKey)`·recruiter: `step === 5`. */
  enabled: boolean;
  /** config_copied를 BE 신호 없이 done으로 볼지 — connect-step: Copy클릭 시점(`hasCopied`,
   * 동적)·recruiter: 항상 true(STEP4 번들 다운로드 완주 시점이라 이미 완료로 간주, 기존
   * recruiter-client.tsx 주석 "번들 다운로드=STEP3 완주로 이미 완료" 그대로 보존). */
  configCopiedDone: boolean;
}

export interface UseVerificationRailResult {
  displaySteps: DisplayStep[];
  verified: boolean;
  verifying: boolean;
  handleVerify: () => Promise<void>;
  /** 「호스팅 · 4단계」/「로컬 · 6단계」— transport 무관 항상 채워진다(story #2407 ②-3: 예전엔
   * recruiter가 http에서만 채우고 stdio에선 빈 문자열이었다 — 아무 근거 없는 비대칭이라 통일). */
  railStageLabel: string;
  copiedVerifyPrompt: boolean;
  handleCopyVerifyPrompt: () => Promise<void>;
  /** story #2407 ②-4: http는 heartbeat(tool 호출)가 verify 메커니즘 자체라 예시프롬프트가
   * 인과적으로 맞는 안내이지만, stdio는 세션이 살아있으면 이벤트 ack가 자동으로 진행돼
   * "tool을 부르면 완료된다"는 문구가 부정확하다(agent_verify.py get_verification_state 축
   * 분기 확認) — connect-step의 기존 `transport === 'http' && !verified` 게이팅이 기술적으로
   * 옳은 쪽이라 그걸로 통일한다(예전 recruiter는 transport 무관 항상 노출했다). */
  showVerifyExamplePrompt: boolean;
  /** story #4cdad425 — 검증 폴링 진행 중이나 아직 verified 아님(«연결 확인 중» 대기 표시용).
   * enabled·agentId·transport 준비되고 verified 전이면 true. */
  awaitingVerification: boolean;
  /** story #4cdad425 — VERIFY_TIMEOUT_MS 지나도 verified 안 됨(진단 힌트 표시용). verified되면 false로
   * 자동 복귀·수동 재시도(handleVerify)나 transport 전환 시 타이머 재무장. */
  timedOut: boolean;
}

/** story #2407 ②-3 — 두 콜러가 각자 계산하되 recruiter만 stdio에서 빈 문자열이었다(무근거
 * 비대칭). 순수함수로 뽑아 pin — transport 무관 항상 채워진다. */
export function computeRailStageLabel(
  transport: Transport | null,
  t: (key: 'railStageHosted' | 'railStageLocal') => string,
): string {
  return transport === 'http' ? t('railStageHosted') : t('railStageLocal');
}

/** story #2407 ②-4 — http만 heartbeat(tool 호출)가 verify 메커니즘 자체라 예시프롬프트가
 * 인과적으로 맞다. stdio는 세션이 살아있으면 이벤트 ack가 자동 진행돼 문구가 부정확해진다
 * (agent_verify.py get_verification_state 축 분기 확認). connect-step의 기존 게이팅이 기술적으로
 * 옳은 쪽이라 그걸로 통일 — 예전 recruiter는 transport 무관 항상 노출했다(순수함수로 뽑아 pin). */
export function computeShowVerifyExamplePrompt(transport: Transport | null, verified: boolean): boolean {
  return transport === 'http' && !verified;
}

/**
 * story #2407 — recruiter-client.tsx·connect-step.tsx가 검증 레일 상태파생·폴링·핸들러를
 * 각자 재구현하던 것(①7건 완전동일 + ②-3/②-4 두 가지 무근거 비대칭)을 하나로 모은다.
 * 파싱만 이미 #2415가 모았고(parseVerificationRail), 그 위 축은 그대로 두 벌이었다.
 *
 * ⛔의도적으로 «안» 옮긴 것 — connect-step에만 있던 「waiting→active」 로컬 보정 분기
 * (hasCopied && !beSteps일 때 pending을 active로 덮어쓰던 것). #2407 조사 中 미르코 라이브
 * 실측(http 축, story #2422/#2423 인접 조사)이 확認: `heartbeat_fresh` 하나가 http 레일
 * 전체를 한 번에 뒤집는 구조라 애초에 "부분 상태"가 정의돼 있지 않다 — 그 보정은 첫 폴
 * 응답 前 잠깐의 화면 표시일 뿐 실제 관측 가능한 차이를 만들지 않았다.
 * PO 판정(2026-08-02): 결함이 아니라 설계 그대로 — 제거해도 관측 가능한 손실이 없다.
 *
 * story #2467 respec(2026-08-18) — 2.5초 setInterval polling 철거. 「살아있음 신호」는 이제
 * BE가 push하는 named SSE 이벤트(`onboarding.rail_signal` — agent_gateway.py 두 지점:
 * ①/stream 연결 직후 자동 verify 기동→mcp_reachable ②/events/ack에서 verify round-trip
 * 완료→verified)로만 받는다. 재조회(GET verification-status)는 ⓐ마운트 시 1회(재로드/재진입
 * 복원용) ⓑSSE push 도착 시 1회, 둘 다 반복 타이머가 아니라 이벤트 트리거 단발 호출이다.
 */
export function useVerificationRail({
  agentId,
  transport,
  enabled,
  configCopiedDone,
}: UseVerificationRailOptions): UseVerificationRailResult {
  const t = useTranslations('onboarding');
  const [beSteps, setBeSteps] = useState<RawStep[] | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [copiedVerifyPrompt, setCopiedVerifyPrompt] = useState(false);
  // story #4cdad425 — 진단 힌트 타이머. verifyNonce는 수동 재시도 시 타이머를 재무장하는 트리거.
  const [timedOut, setTimedOut] = useState(false);
  const [verifyNonce, setVerifyNonce] = useState(0);

  const pollStatus = useCallback(async (forAgentId: string, forTransport: Transport) => {
    try {
      const res = await fetchWithAuth(`/api/agents/${forAgentId}/verification-status?transport=${forTransport}`);
      if (!res.ok) return; // 미머지/404 → pending 유지(가짜 에러 안 띄움)
      const raw = parseVerificationRail(await res.json());
      if (raw) setBeSteps(raw);
    } catch {
      // swallow — graceful degradation
    }
  }, []);

  // 마운트/transport전환 1회 스냅샷 — 반복 타이머 아님(재로드 시 이미 진행된 상태 복원용).
  useEffect(() => {
    if (!enabled || !agentId || !transport) return;
    setBeSteps(null); // transport 전환 시 이전 transport의 레일 상태가 새 레일에 새는 것 방지
    void pollStatus(agentId, transport);
  }, [enabled, agentId, transport, pollStatus]);

  // story #2467 respec — 살아있음 신호 수신(SSE push) → 그 즉시 단발 재조회. 반복 타이머 없음
  // (grep 검산 대상: 이 파일에 setInterval 0).
  const handleRailSignal = useCallback((_eventName: string, data: unknown) => {
    const payload = data as { agent_id?: string } | null;
    if (!enabled || !agentId || !transport) return;
    if (!payload || payload.agent_id !== agentId) return; // 다른 에이전트의 신호는 무시
    void pollStatus(agentId, transport);
  }, [enabled, agentId, transport, pollStatus]);

  useSseNotifications({
    enabled: enabled && Boolean(agentId) && Boolean(transport),
    extraEventNames: ['onboarding.rail_signal'],
    onExtraEvent: handleRailSignal,
  });

  // story #4cdad425 — 진단 힌트 타이머. 폴링이 시작되면(또는 transport 전환·수동 재시도로 verifyNonce가
  // 오르면) 재무장하고, VERIFY_TIMEOUT_MS 지나도 verified가 안 되면 timedOut을 켠다. 폴링은 멈추지
  // 않는다 — 늦게라도 성공하면 아래 verified 파생이 true가 되어 소비처가 힌트를 자동으로 감춘다.
  useEffect(() => {
    if (!enabled || !agentId || !transport) {
      setTimedOut(false);
      return;
    }
    setTimedOut(false);
    const timer = setTimeout(() => setTimedOut(true), VERIFY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [enabled, agentId, transport, verifyNonce]);

  const railOrder = transport === 'http' ? HTTP_RAIL_ORDER : RAIL_ORDER;
  const displaySteps: DisplayStep[] = railOrder.map((state) => {
    const be = beSteps?.find((s) => s.state === state);
    let status: RailStatus = be?.status ?? 'pending';
    if (state === 'config_copied' && configCopiedDone && status === 'pending') status = 'done';
    return { state, status, label: t(RAIL_LABEL_KEY[state]), reason: be?.reason };
  });
  const verified = displaySteps.find((s) => s.state === 'verified')?.status === 'done';

  const handleVerify = useCallback(async () => {
    if (!agentId || !transport) return;
    // story #4cdad425 — 수동 재시도는 진단 타이머를 재무장(힌트 감춤 + 60s 다시 셈).
    setTimedOut(false);
    setVerifyNonce((n) => n + 1);
    setVerifying(true);
    try {
      await fetchWithAuth(`/api/agents/${agentId}/verify-connection?transport=${transport}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(() => {});
      await pollStatus(agentId, transport);
    } finally {
      setVerifying(false);
    }
  }, [agentId, transport, pollStatus]);

  const handleCopyVerifyPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(t('verifyExamplePrompt'));
      setCopiedVerifyPrompt(true);
      setTimeout(() => setCopiedVerifyPrompt(false), 2000);
    } catch {
      // ignore clipboard failure
    }
  }, [t]);

  return {
    displaySteps,
    verified,
    verifying,
    handleVerify,
    railStageLabel: computeRailStageLabel(transport, t),
    copiedVerifyPrompt,
    handleCopyVerifyPrompt,
    showVerifyExamplePrompt: computeShowVerifyExamplePrompt(transport, verified),
    // verified되면 대기·타임아웃 표시는 자동으로 꺼진다(늦게 성공해도 힌트가 안 남는다).
    awaitingVerification: enabled && Boolean(agentId) && Boolean(transport) && !verified,
    timedOut: timedOut && !verified,
  };
}

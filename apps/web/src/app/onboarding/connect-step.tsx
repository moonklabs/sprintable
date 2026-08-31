'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { FileText, Copy, Check, RefreshCw, ChevronRight, Info, Cloud, Terminal, Sparkles, RotateCw, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import {
  VerifyRail, useVerificationRail,
  type Transport,
} from './verify-rail';
import { emitOnboardingEvent, beaconOnboardingEvent } from './onboarding-telemetry';

import { fetchWithAuth, refreshAuthTokens } from '@/lib/db/client';
import { createFirstInstructionConversation } from '@/lib/onboarding/first-instruction';

// story #2407 — Transport는 이제 verify-rail.tsx가 소유(useVerificationRail이 그 값을 직접
// 다룸). 이 re-export는 기존 소비자(onboarding-form.tsx 등)의 import 경로를 안 건드리려는
// 하위호환 자리 — 새 소비자는 verify-rail에서 바로 import한다.
export type { Transport };

/** connection-artifact content(JSON)의 `mcpServers['sprintable-mcp'].type` 필드만 읽는다(재조립 아님) —
 * transport 미지정 최초 요청은 BE edition 기본을 반환하므로, 어느 탭을 pre-select할지 이걸로 판별.
 * #2577: 서버키 sprintable -> sprintable-mcp (BE agent_onboarding_config.py SSOT). */
export function inferTransport(content: string): Transport {
  try {
    const parsed = JSON.parse(content) as { mcpServers?: { 'sprintable-mcp'?: { type?: string } } };
    return parsed?.mcpServers?.['sprintable-mcp']?.type === 'http' ? 'http' : 'stdio';
  } catch {
    return 'stdio';
  }
}

interface ConnectStepProps {
  agentId: string | null;
  apiKey: string | null;
  projectId: string | null;
  onFinish: () => void;
}

/** `sk_live_••••<last4>` — prefix + 마지막 4자만 노출.
 * story #2751: 워크포스 › 에이전트 상세의 "연결 설정" 상시 섹션도 이 마스킹을 재사용한다
 * (재발급 직후에만 실키를 다루는 로컬 규약은 그대로 — 여기선 export만 추가, 동작 변경 0). */
export function maskApiKey(key: string): string {
  if (!key) return '';
  const last4 = key.slice(-4);
  const m = key.match(/^(sk_(?:live|test)_)/);
  const prefix = m ? m[1] : '';
  return `${prefix}••••${last4}`;
}

/**
 * 아티팩트 렌더 — **서버 SSOT**(AC3): 구조+backend-direct URL은 OB-1 connection-artifact content 그대로.
 * 클라는 config를 재조립하지 않는다(buildConfig 제거). 키 placeholder(`<YOUR_AGENT_API_KEY>`)만
 * first-run 실 키로 치환(display=마스킹·copy=실키). OB-1 content 부재 시 null → 카드는 pending.
 */
export function renderArtifact(baseContent: string | null, apiKey: string, mask: boolean): string | null {
  if (!baseContent) return null;
  const key = mask ? maskApiKey(apiKey) : apiKey;
  try {
    const parsed = JSON.parse(baseContent) as {
      mcpServers?: { 'sprintable-mcp'?: { env?: Record<string, string> } };
    };
    const env = parsed?.mcpServers?.['sprintable-mcp']?.env;
    if (env && 'AGENT_API_KEY' in env) {
      env.AGENT_API_KEY = key;
      return JSON.stringify(parsed, null, 2);
    }
    // 구조가 예상과 달라도 클라 재조립 금지 — placeholder 치환으로 SSOT 보존
    return baseContent.replace('<YOUR_AGENT_API_KEY>', key);
  } catch {
    return baseContent.replace('<YOUR_AGENT_API_KEY>', key);
  }
}

export function HighlightedJson({ text }: { text: string }) {
  const segments: { t: string; c?: string }[] = [];
  const regex = /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|([{}[\],])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) segments.push({ t: text.slice(last, m.index) });
    if (m[1]) segments.push({ t: m[1], c: 'text-primary' });
    else if (m[2]) segments.push({ t: m[2], c: 'text-success' });
    else if (m[3]) segments.push({ t: m[3], c: 'text-muted-foreground' });
    last = regex.lastIndex;
  }
  if (last < text.length) segments.push({ t: text.slice(last) });
  return (
    <>
      {segments.map((s, i) => (s.c ? <span key={i} className={s.c}>{s.t}</span> : <span key={i}>{s.t}</span>))}
    </>
  );
}

export function ConnectStep({ agentId, apiKey, projectId, onFinish }: ConnectStepProps) {
  const t = useTranslations('onboarding');

  // transport=null: 최초 default-resolve 응답 대기 中(BE edition 기본 판별 前).
  const [transport, setTransport] = useState<Transport | null>(null);
  const [artifacts, setArtifacts] = useState<Partial<Record<Transport, string>>>({});
  const [artifactErrors, setArtifactErrors] = useState<Partial<Record<Transport, boolean>>>({});
  // transport 미판별 상태(최초 default-resolve 요청)에서의 실패 — 이후엔 위 per-transport 에러로 대체.
  const [initialError, setInitialError] = useState(false);
  const [hostedUnavailable, setHostedUnavailable] = useState(false);
  const [hasCopiedMap, setHasCopiedMap] = useState<Partial<Record<Transport, boolean>>>({});
  const [justCopied, setJustCopied] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const leftRef = useRef(false);

  const hasCopied = transport ? Boolean(hasCopiedMap[transport]) : false;
  // misconfig 폴백(아래) — edition 기본이 http인데 배포가 없을 때 stdio로 명시 재요청해야
  // 한다. useCallback으로 메모된 fetchArtifact가 자기 자신을 몸체 안에서 직접 호출하면
  // eslint-plugin-react-hooks(immutability)가 "선언 前 접근"으로 잡는다(TDZ 우려 — 이 값이
  // 시간에 따라 갱신될 때 몸체 안 참조가 갱신 前 클로저를 볼 수 있다는 경고) — effect로
  // 한 단계 분리해 자기참조 자체를 없앤다.
  const [needsStdioFallback, setNeedsStdioFallback] = useState(false);

  // OB-1 connection-artifact = 아티팩트 SSOT(구조+backend-direct URL). OB-1 라이브라 정상응답 디폴트.
  // 실패 시 클라빌드로 메우지 않고(§2 CF env 노출 금지·AC3) pending+재시도 유지.
  // E-MCP-OPT S3: reqTransport 생략 시 BE가 edition 기본을 판별해 반환 — 최초 1회만 이렇게 호출해
  // 어느 탭을 pre-select할지 응답 content의 `type` 필드로 역산한다(§5, FE round-trip 없이 SSOT 보존).
  const fetchArtifact = useCallback(async (reqTransport?: Transport) => {
    if (!agentId) return;
    if (!reqTransport) setInitialError(false);
    try {
      const qs = reqTransport ? `?transport=${reqTransport}` : '';
      const res = await fetchWithAuth(`/api/agents/${agentId}/connection-artifact${qs}`);
      if (!res.ok) {
        if (reqTransport === 'http' && res.status === 400) {
          // MCP_PUBLIC_URL 미설정 환경(OSS/로컬) — "탭 자체가 없음"(BE 계약), 에러 아님.
          setHostedUnavailable(true);
          return;
        }
        if (!reqTransport && res.status === 400) {
          // edition 기본이 http로 잡혔는데 이 환경엔 배포가 없는 misconfig — stdio는 항상 가능하다는
          // BE invariant를 믿고 명시 폴백(무한 pending 방치 금지). 자기참조 없이 아래 effect가 잇는다.
          setHostedUnavailable(true);
          setNeedsStdioFallback(true);
          return;
        }
        if (reqTransport) setArtifactErrors((p) => ({ ...p, [reqTransport]: true }));
        else setInitialError(true);
        return;
      }
      // story #3192(온보딩·크럭스) — BE 응답 shape이 이미 `{content}` 단일파일에서 `{files[],
      // mcp_config, api_key}`(agents.py::_connection_artifact, `⚠️BREAKING(dev-only)` 주석
      // 참조)로 바뀐 뒤였는데 이 fetchArtifact만 옛 `content` 필드를 계속 읽고 있었다 — 신규
      // 계정은 항상 `content=undefined`라 아티팩트가 절대 안 채워지는(재시도해도 동일 mismatch
      // 재발) 크럭스였다. agent-connection-settings-section.tsx(story #2751, 같은 BE 응답을
      // 먼저 새 shape으로 고쳐 소비하던 자매 소비처)의 파싱을 그대로 재사용(발명 0).
      const json = (await res.json()) as {
        data?: { files?: { filename: string; content: string }[] };
        files?: { filename: string; content: string }[];
      };
      const payload = json?.data ?? json;
      const mcpFile = (payload?.files ?? []).find((f) => f.filename === '.mcp.json');
      const content = mcpFile?.content;
      if (typeof content !== 'string') {
        if (reqTransport) setArtifactErrors((p) => ({ ...p, [reqTransport]: true }));
        else setInitialError(true);
        return;
      }
      const resolved = reqTransport ?? inferTransport(content);
      setArtifacts((p) => ({ ...p, [resolved]: content }));
      setArtifactErrors((p) => ({ ...p, [resolved]: false }));
      setTransport((cur) => cur ?? resolved);
    } catch {
      if (reqTransport) setArtifactErrors((p) => ({ ...p, [reqTransport]: true }));
      else setInitialError(true);
    }
  }, [agentId]);

  // 최초 마운트 — transport 미지정 요청으로 BE edition 기본 판별.
  // story #2407 정리 中 걸렸던 lint(react-hooks/set-state-in-effect, fetchArtifact 비동기
  // setState를 정적분석이 "effect 안 setState"로 잡던 자리)에 disable 세 개를 부채로
  // 명시해 뒀었다 — story #3201로 이 컴포넌트에 새 상태/핸들러가 늘며 분석 범위가 바뀌어
  // (재평가 조건 그대로 발동, 위 원래 주석 참고) eslint가 세 disable 전부 "unused"로 재판정
  // 했다(재확認: 이 세 effect 자체는 손 안 댐). 부채 걷음 — disable 제거.
  useEffect(() => {
    if (!agentId || !apiKey) return;
    void fetchArtifact();
  }, [agentId, apiKey, fetchArtifact]);

  useEffect(() => {
    if (!needsStdioFallback) return;
    setNeedsStdioFallback(false);
    void fetchArtifact('stdio');
  }, [needsStdioFallback, fetchArtifact]);

  // 탭 전환 — 아직 fetch 안 한 transport 만 재요청(§5 "탭 전환마다 재요청"·이미 캐시된 건 재요청 생략).
  useEffect(() => {
    if (!agentId || !apiKey || !transport) return;
    if (artifacts[transport]) return;
    if (transport === 'http' && hostedUnavailable) return;
    void fetchArtifact(transport);
  }, [agentId, apiKey, transport, artifacts, hostedUnavailable, fetchArtifact]);

  // story #2407 — 상태파생·폴링·핸들러는 verify-rail.tsx의 useVerificationRail로 이동(원래
  // recruiter-client.tsx와 각자 재구현하던 자리 — #2404의 steps/rail 필드명 버그가 두 곳에
  // 동시에 있었던 이유). enabled=Boolean(apiKey)로 기존 게이팅(agentId·apiKey·transport 전부
  // 준비된 뒤에만 폴링 시작) 그대로 보존.
  const rail = useVerificationRail({
    agentId,
    transport,
    enabled: Boolean(apiKey),
    configCopiedDone: hasCopied,
  });
  const { displaySteps, verified, verifying, awaitingVerification, timedOut } = rail;

  // unload(탭닫기/이탈) best-effort — 미검증 시 abandoned_explicit 보조 신호(SoT는 BE 파생).
  useEffect(() => {
    const onHide = () => {
      if (leftRef.current || verified) return;
      beaconOnboardingEvent('abandoned_explicit', { agent_id: agentId, failure_reason: 'abandoned_explicit', flow: 'onboarding' });
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [agentId, verified]);

  const handleCopy = async () => {
    if (!apiKey || !transport) return;
    const cfg = renderArtifact(artifacts[transport] ?? null, apiKey, false);
    if (!cfg) return; // 아티팩트 미준비(pending) — copy 불가
    try {
      await navigator.clipboard.writeText(cfg);
    } catch {
      // ignore clipboard failure
    }
    setHasCopiedMap((p) => ({ ...p, [transport]: true }));
    setJustCopied(true);
    setTimeout(() => setJustCopied(false), 2000);
    emitOnboardingEvent('config_copied', { agent_id: agentId, flow: 'onboarding' });
  };

  // story #2404 — "설정만 넣으면 자동으로 된다"는 오해가 무한 대기의 실원인이었다(검증은 실제
  // tool 호출로만 완료됨, AC5 PO 확定). 지금 할 일을 복사 가능한 한 줄로 그 자리에 쥐여 준다.
  // #2407 후속: 복사 로직 자체는 useVerificationRail로 이동, 여기선 그대로 재노출.
  const handleCopyVerifyPrompt = rail.handleCopyVerifyPrompt;

  const handleVerify = async () => {
    if (!agentId || !transport) return;
    emitOnboardingEvent('verify_started', { agent_id: agentId, flow: 'onboarding' });
    await rail.handleVerify();
  };

  const handleDashboard = () => {
    leftRef.current = true;
    if (!verified) {
      emitOnboardingEvent('abandoned_explicit', { agent_id: agentId, failure_reason: 'abandoned_explicit', flow: 'onboarding' });
    }
    onFinish();
  };

  // story #3201(activation·절벽 처방) — 1차 깔때기 "연결까지 온 사람 중 첫 왕복 0%" 절벽.
  // PO 확定(2026-08-29): verified 무관 상시 노출(미연결인 채 눌러도 새 DM에서 #3194 침묵
  // 배너가 다음 행동을 안내하는 자기정합 구조). 생성 실패 시 onFinish()로 폴백(제3경로
  // 발명 대신 기존 대시보드 이동 재사용 — 사용자를 막다른 곳에 두지 않음).
  const [startingInstruction, setStartingInstruction] = useState(false);
  const handleFirstInstruction = async () => {
    if (!projectId || startingInstruction) return;
    leftRef.current = true;
    setStartingInstruction(true);
    try {
      const convId = await createFirstInstructionConversation(projectId, agentId);
      if (!convId) {
        onFinish();
        return;
      }
      // story #2691 가드(verify-no-new-raw-fetch-api) — onboarding-form.tsx::finishToHome()의
      // auth 토큰 갱신 raw fetch 호출을 그대로 베끼지 않고, 같은 목적의 기존 헬퍼
      // (lib/db/client.ts의 refreshAuthTokens, callAuthRoute 경유)를 재사용한다.
      await refreshAuthTokens().catch(() => null);
      window.location.href = `/chats/${convId}`;
    } catch {
      onFinish();
    } finally {
      setStartingInstruction(false);
    }
  };

  // 키 발급 실패 폴백(기존 동작 보존) — 아티팩트 없이 멤버 관리로 유도.
  if (!apiKey) {
    return (
      <div className="space-y-4">
        <div className="space-y-2 rounded-md border border-warning-border bg-warning-tint p-3">
          <p className="text-sm text-warning-strong">{t('apiKeyFailedMembers')}</p>
          <Link
            href="/settings?tab=members"
            className="inline-block rounded border border-warning-border bg-background px-3 py-1 text-xs font-medium text-warning-strong transition-colors hover:bg-warning-tint"
          >
            {t('goToMembersAgents')} →
          </Link>
        </div>
        <Button variant="glass" size="lg" className="w-full" onClick={onFinish}>
          {t('dashboardCta')}
        </Button>
      </div>
    );
  }

  const artifactBase = transport ? (artifacts[transport] ?? null) : null;
  const artifactError = transport ? Boolean(artifactErrors[transport]) : initialError;
  const isHostedUnavailable = transport === 'http' && hostedUnavailable;
  const displayConfig = renderArtifact(artifactBase, apiKey, true);

  return (
    <div className="space-y-4">
      {/* [0] transport 세그먼트 토글 */}
      <div className="flex gap-0 rounded-md border border-border bg-muted p-[3px]">
        <button
          type="button"
          onClick={() => setTransport('http')}
          disabled={!transport}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors',
            transport === 'http' && 'bg-background text-foreground shadow-sm',
          )}
        >
          <Cloud className="h-3.5 w-3.5" aria-hidden />
          {t('transportHosted')}
          <Badge variant="info" className="px-1.5 py-0 text-[9px]">{t('transportRecommended')}</Badge>
        </button>
        <button
          type="button"
          onClick={() => setTransport('stdio')}
          disabled={!transport}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors',
            transport === 'stdio' && 'bg-background text-foreground shadow-sm',
          )}
        >
          <Terminal className="h-3.5 w-3.5" aria-hidden />
          {t('transportLocal')}
        </button>
      </div>

      {/* [1] 아티팩트 카드 */}
      <section className="space-y-2">
        <div className="overflow-hidden rounded-md border border-border">
          <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="font-mono text-xs text-foreground">.mcp.json</span>
              <Badge variant="outline" className="shrink-0 text-xs">Claude Code</Badge>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleCopy()}
              disabled={!displayConfig}
              aria-label={t('copyConfig')}
              className="shrink-0 whitespace-nowrap"
            >
              {justCopied ? (
                <><Check className="h-3.5 w-3.5" />{t('copied')}</>
              ) : (
                <><Copy className="h-3.5 w-3.5" />{t('copyConfig')}</>
              )}
            </Button>
          </div>
          {displayConfig ? (
            <pre className="overflow-x-auto bg-muted/40 p-3 text-xs leading-relaxed">
              <code className="font-mono"><HighlightedJson text={displayConfig} /></code>
            </pre>
          ) : (
            <div className="space-y-2 bg-muted/40 p-3" aria-busy={!artifactError && !isHostedUnavailable}>
              <div className={cn('h-3 w-3/4 rounded bg-muted', !artifactError && !isHostedUnavailable && 'animate-pulse')} />
              <div className={cn('h-3 w-1/2 rounded bg-muted', !artifactError && !isHostedUnavailable && 'animate-pulse')} />
              <div className={cn('h-3 w-2/3 rounded bg-muted', !artifactError && !isHostedUnavailable && 'animate-pulse')} />
              <div className="flex items-center gap-2 pt-1">
                {/* story #3192 ② — api_key:null 200(또는 shape mismatch) 후 실패 상태를 계속
                    "생성 중…"으로 위장하던 분기 제거. artifactError면 정직하게 실패를 알린다 —
                    재시도 버튼과 짝을 이루는 문구라야 "눌러도 안 됨"으로 안 읽힌다. */}
                <p className="text-xs text-muted-foreground">
                  {isHostedUnavailable ? t('artifactUnavailable') : artifactError ? t('artifactError') : t('artifactPending')}
                </p>
                {artifactError && !isHostedUnavailable && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void fetchArtifact(transport ?? undefined)}
                    className="h-auto px-2 py-0.5 text-xs"
                  >
                    {t('artifactRetry')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
        {transport === 'http' && !isHostedUnavailable && (
          // story #2590(TIER3) — tint 위 계열색 글자는 text-foreground(#2420 규칙).
          <div className="flex items-start gap-2 rounded-md border border-info-border bg-info-tint px-3 py-2.5 text-xs text-foreground">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{t('hostedBenefit')}</span>
          </div>
        )}
        {transport === 'stdio' && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {t('localGuideNote')}
          </p>
        )}
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('artifactGuide')}
        </p>
        <p className="text-xs text-muted-foreground">{t('keyOneTimeNote')}</p>
        {/* story #4cdad425(prod 에스컬레이트) — 「설정만 붙이면 자동」 오해가 무한 대기의 근본이었다
            (실유저 5회 재시도). 설정 저장 뒤 «Claude Code 재시작»이 연결 적용의 필수 단계라 그
            자리에 명시한다. info 톤(안내·연결 미확認≠에러). */}
        <div className="flex items-start gap-2 rounded-md border border-info-border bg-info-tint px-3 py-2.5 text-xs text-foreground">
          <RotateCw className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{t('restartAfterConfig')}</span>
        </div>
      </section>

      {/* [2] verify 상태레일 */}
      <section className="space-y-3 border-t border-border pt-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">
            {t('verifyTitle')}{' '}
            <span className={cn('text-xs font-normal', transport === 'http' ? 'text-info' : 'text-muted-foreground')}>
              {rail.railStageLabel}
            </span>
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleVerify()}
            disabled={verifying || !transport}
            aria-label={t('verifyRetry')}
            className="shrink-0 whitespace-nowrap"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', verifying && 'animate-spin')} />
            {t('verifyRetry')}
          </Button>
        </div>
        <VerifyRail steps={displaySteps} />
        {/* story #4cdad425 ② — 폴링이 도는데 화면이 침묵하면(무한 폴링 가림) 실유저는 «멈췄다»고
            느껴 재시도한다. 확인 중임을 명시한다. verified/timeout이면 자동으로 사라진다. */}
        {awaitingVerification && !timedOut && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
            {t('verifyWaiting')}
          </p>
        )}
        {/* story #4cdad425 ③ — 타임아웃(~60s) 시 침묵 대신 진단 힌트. 색은 info 톤(연결이 아직
            «확인 안 됨»이지 «실패»가 아니다 — 빨강 안 씀·내 색 규율). text-foreground on info-tint(#2420). */}
        {timedOut && (
          <div role="status" aria-live="polite" className="rounded-md border border-info-border bg-info-tint px-3 py-2.5 text-xs text-foreground">
            <p className="font-medium">{t('verifyTimeoutTitle')}</p>
            <p className="mt-1">{t('verifyTimeoutHint')}</p>
          </div>
        )}
        {transport === 'http' && (
          <p className="flex items-start gap-1.5 text-xs text-info">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {t('hostedVerifyNote')}
          </p>
        )}
        {rail.showVerifyExamplePrompt && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-info-border bg-info-tint px-3 py-2 text-xs">
            <span className="min-w-0 truncate text-foreground">
              {t('verifyExampleLabel')} <span className="font-mono text-foreground">&ldquo;{t('verifyExamplePrompt')}&rdquo;</span>
            </span>
            <Button variant="outline" size="sm" onClick={() => void handleCopyVerifyPrompt()} className="shrink-0">
              {rail.copiedVerifyPrompt ? <><Check className="h-3.5 w-3.5" />{t('copied')}</> : <><Copy className="h-3.5 w-3.5" />{t('copyConfig')}</>}
            </Button>
          </div>
        )}
        {verified && (
          // story #2105 2차 — 검증 성공 결과도 polite로 낭독(#2096/#2105 1차와 동일 원칙).
          // story #2590(TIER3) — tint 위 계열색 글자는 text-foreground(#2420 규칙).
          <div role="status" aria-live="polite" aria-atomic="true" className="rounded-md border border-success/20 bg-success/10 px-3 py-2.5 text-sm text-foreground">
            {t('verifiedBanner')}
          </div>
        )}
      </section>

      {/* [3] 고급 설정 (기본 접힘) */}
      <section className="border-t border-border pt-4">
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-2 text-left"
          aria-expanded={advancedOpen}
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">{t('advancedTitle')}</span>
            <span className="block text-xs text-muted-foreground">{t('advancedSubtitle')}</span>
          </span>
          <ChevronRight
            className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', advancedOpen && 'rotate-90')}
            aria-hidden
          />
        </button>
        {advancedOpen && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground">{t('advancedNote')}</p>
            <Link href="/settings?tab=members" className="inline-block text-xs font-medium text-primary hover:underline">
              {t('goToMembersAgents')} →
            </Link>
          </div>
        )}
      </section>

      {/* 푸터 — story #3201: "첫 지시 보내기"가 주 CTA(1차 깔때기 절벽 처방), 대시보드 가기는
          보조. verified 무관 상시 노출(PO 확定 — 미연결인 채 눌러도 새 DM에서 #3194 침묵
          배너가 다음 행동을 안내). */}
      <div className="flex flex-col items-stretch gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-xs text-muted-foreground">{t('connectFooterHint')}</p>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button
            variant="glass"
            size="sm"
            onClick={handleDashboard}
            className="whitespace-nowrap"
          >
            {t('dashboardCta')}
          </Button>
          <Button
            variant="hero"
            size="sm"
            onClick={() => void handleFirstInstruction()}
            disabled={!projectId || startingInstruction}
            className="whitespace-nowrap"
          >
            {startingInstruction ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('firstInstructionStarting')}</>
            ) : (
              t('firstInstructionCta')
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

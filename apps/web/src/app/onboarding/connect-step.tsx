'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { FileText, Copy, Check, RefreshCw, ChevronRight, Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { VerifyRail, RAIL_ORDER, type DisplayStep, type RailState, type RailStatus } from './verify-rail';
import { emitOnboardingEvent, beaconOnboardingEvent } from './onboarding-telemetry';

// backend-direct URL (agent가 로컬에서 직접 호출) — CF 경유 금지(blueprint §2). NEXT_PUBLIC이라 클라 인라인.
const BACKEND_URL = process.env.NEXT_PUBLIC_FASTAPI_URL ?? 'http://localhost:8000';

const RAIL_LABEL_KEY: Record<RailState, string> = {
  config_copied: 'railConfigCopied',
  waiting: 'railWaiting',
  mcp_reachable: 'railMcpReachable',
  event_delivered: 'railEventDelivered',
  ack: 'railAck',
  verified: 'railVerified',
};

interface RawStep {
  state: RailState;
  status: RailStatus;
  reason?: string;
}

interface ConnectStepProps {
  agentId: string | null;
  apiKey: string | null;
  onFinish: () => void;
}

/** stdio working config. AGENT_API_KEY 값만 마스킹 가능(나머지 JSON은 평문 가독). */
function buildConfig(apiKey: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        sprintable: {
          type: 'stdio',
          command: 'uvx',
          args: ['sprintable-mcp'],
          env: { SPRINTABLE_API_URL: BACKEND_URL, AGENT_API_KEY: apiKey },
        },
      },
    },
    null,
    2,
  );
}

/** `sk_live_••••<last4>` — prefix + 마지막 4자만 노출. */
function maskApiKey(key: string): string {
  if (!key) return '';
  const last4 = key.slice(-4);
  const m = key.match(/^(sk_(?:live|test)_)/);
  const prefix = m ? m[1] : '';
  return `${prefix}••••${last4}`;
}

/**
 * 아티팩트 렌더 — URL 소스 우선순위: OB-1 connection-artifact content(backend-direct URL 권위).
 * OB-1 미머지/404 시 FE-built fallback(provisional·env URL). 키는 first-run newApiKey 주입(display=마스킹).
 * ⚠️ 실 working URL은 OB-1(SPRINTABLE_API_URL=backend-direct·CF 금지)이 소유 — env fallback은 임시.
 */
function renderArtifact(baseContent: string | null, apiKey: string, mask: boolean): string {
  const key = mask ? maskApiKey(apiKey) : apiKey;
  if (baseContent) {
    try {
      const parsed = JSON.parse(baseContent) as {
        mcpServers?: { sprintable?: { env?: Record<string, string> } };
      };
      const env = parsed?.mcpServers?.sprintable?.env;
      if (env) {
        env.AGENT_API_KEY = key;
        return JSON.stringify(parsed, null, 2);
      }
    } catch {
      // OB-1 content 파싱 실패 → fallback
    }
  }
  return buildConfig(key);
}

function HighlightedJson({ text }: { text: string }) {
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

export function ConnectStep({ agentId, apiKey, onFinish }: ConnectStepProps) {
  const t = useTranslations('onboarding');

  const [artifactBase, setArtifactBase] = useState<string | null>(null);
  const [beSteps, setBeSteps] = useState<RawStep[] | null>(null);
  const [hasCopied, setHasCopied] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const leftRef = useRef(false);

  // OB-2 verification-status poll (SSE-우선은 OB-2 SSE 포맷 확정 후 follow-up·현재 poll). 404 graceful.
  const pollStatus = useCallback(async () => {
    if (!agentId) return;
    try {
      const res = await fetch(`/api/agents/${agentId}/verification-status`);
      if (!res.ok) return; // 미머지/404 → pending 유지(가짜 에러 안 띄움)
      const json = (await res.json()) as { data?: { steps?: RawStep[] } | RawStep[]; steps?: RawStep[] };
      const d = json?.data;
      const raw = (Array.isArray(d) ? d : d?.steps) ?? json?.steps;
      if (Array.isArray(raw)) setBeSteps(raw);
    } catch {
      // swallow — graceful degradation
    }
  }, [agentId]);

  useEffect(() => {
    if (!agentId || !apiKey) return;
    void pollStatus();
    const iv = setInterval(() => void pollStatus(), 2500);
    return () => clearInterval(iv);
  }, [agentId, apiKey, pollStatus]);

  // OB-1 connection-artifact = URL 소스(backend-direct 권위). 404/미머지 시 FE-built fallback.
  useEffect(() => {
    if (!agentId || !apiKey) return;
    let active = true;
    void (async () => {
      try {
        const res = await fetch(`/api/agents/${agentId}/connection-artifact`);
        if (!res.ok) return; // 미머지/404 → fallback(provisional)
        const json = (await res.json()) as { data?: { content?: string }; content?: string };
        const content = json?.data?.content ?? json?.content;
        if (active && typeof content === 'string') setArtifactBase(content);
      } catch {
        // swallow — graceful
      }
    })();
    return () => { active = false; };
  }, [agentId, apiKey]);

  const displaySteps: DisplayStep[] = RAIL_ORDER.map((state) => {
    const be = beSteps?.find((s) => s.state === state);
    let status: RailStatus = be?.status ?? 'pending';
    // whichever-first: Copy 클릭 OR 첫 OB-2 신호 — config_copied done
    if (state === 'config_copied' && hasCopied && status === 'pending') status = 'done';
    // 복사했고 BE 신호 전이면 다음 단계(연결 대기) active로 표시
    if (state === 'waiting' && hasCopied && !beSteps && status === 'pending') status = 'active';
    return { state, status, label: t(RAIL_LABEL_KEY[state]), reason: be?.reason };
  });
  const verified = displaySteps.find((s) => s.state === 'verified')?.status === 'done';

  // unload(탭닫기/이탈) best-effort — 미검증 시 abandoned_explicit 보조 신호(SoT는 BE 파생).
  useEffect(() => {
    const onHide = () => {
      if (leftRef.current || verified) return;
      beaconOnboardingEvent('abandoned_explicit', { agent_id: agentId, failure_reason: 'abandoned_explicit' });
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [agentId, verified]);

  const handleCopy = async () => {
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(renderArtifact(artifactBase, apiKey, false));
    } catch {
      // ignore clipboard failure
    }
    setHasCopied(true);
    setJustCopied(true);
    setTimeout(() => setJustCopied(false), 2000);
    emitOnboardingEvent('config_copied', { agent_id: agentId });
  };

  const handleVerify = async () => {
    if (!agentId) return;
    setVerifying(true);
    emitOnboardingEvent('verify_started', { agent_id: agentId });
    try {
      await fetch(`/api/agents/${agentId}/verify-connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(() => {});
      await pollStatus();
    } finally {
      setVerifying(false);
    }
  };

  const handleDashboard = () => {
    leftRef.current = true;
    if (!verified) {
      emitOnboardingEvent('abandoned_explicit', { agent_id: agentId, failure_reason: 'abandoned_explicit' });
    }
    onFinish();
  };

  // 키 발급 실패 폴백(기존 동작 보존) — 아티팩트 없이 멤버 관리로 유도.
  if (!apiKey) {
    return (
      <div className="space-y-4">
        <div className="space-y-2 rounded-md border border-amber-500/20 bg-amber-500/10 p-3">
          <p className="text-sm text-amber-600 dark:text-amber-400">{t('apiKeyFailedMembers')}</p>
          <Link
            href="/settings?tab=members"
            className="inline-block rounded border border-amber-500/30 bg-background px-3 py-1 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/10 dark:text-amber-400"
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

  const displayConfig = renderArtifact(artifactBase, apiKey, true);

  return (
    <div className="space-y-4">
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
          <pre className="overflow-x-auto bg-muted/40 p-3 text-xs leading-relaxed">
            <code className="font-mono"><HighlightedJson text={displayConfig} /></code>
          </pre>
        </div>
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('artifactGuide')}
        </p>
        <p className="text-xs text-muted-foreground">{t('keyOneTimeNote')}</p>
      </section>

      {/* [2] verify 상태레일 */}
      <section className="space-y-3 border-t border-border pt-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">{t('verifyTitle')}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleVerify()}
            disabled={verifying}
            aria-label={t('verifyRetry')}
            className="shrink-0 whitespace-nowrap"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', verifying && 'animate-spin')} />
            {t('verifyRetry')}
          </Button>
        </div>
        <VerifyRail steps={displaySteps} />
        {verified && (
          <div className="rounded-md border border-success/20 bg-success/10 px-3 py-2.5 text-sm text-success">
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

      {/* 푸터 */}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <p className="min-w-0 text-xs text-muted-foreground">{t('connectFooterHint')}</p>
        <Button
          variant={verified ? 'hero' : 'glass'}
          size="sm"
          onClick={handleDashboard}
          className="shrink-0 whitespace-nowrap"
        >
          {t('dashboardCta')}
        </Button>
      </div>
    </div>
  );
}

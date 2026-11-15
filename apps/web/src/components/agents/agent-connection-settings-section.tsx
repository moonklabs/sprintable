'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy, Cloud, Terminal, FileText } from 'lucide-react';
import { Button } from '@/components/ds/button';
import { Textarea } from '@/components/ds/input';
import { Skeleton } from '@/components/ds/skeleton';
import { DetailCard } from '@/components/agents/detail-card';
import { fetchWithAuth } from '@/lib/db/client';
import { HighlightedJson, inferTransport, renderArtifact, type Transport } from '@/app/onboarding/connect-step';
import { copyTextSafely } from '@/lib/clipboard';

interface ArtifactFile {
  filename: string;
  content: string;
}

interface ConnectionArtifactResponse {
  files: ArtifactFile[];
}

interface AgentConnectionSettingsSectionProps {
  agentId: string;
  /** story #2751: 방금 재발급된 실 키(있으면 그 값을 placeholder 자리에 채워 넣는다 — 없으면
   * 서버가 이미 보내는 `<YOUR_AGENT_API_KEY>` placeholder를 그대로 노출, 재조회 자체는
   * 언제나 안전(백엔드 코드 확認 — 재조회로 실 키가 새는 구조가 아님, story #2751 설계 doc). */
  freshApiKey: string | null;
}

/**
 * story #2751(설계①, PO 승인 2026-08-18) — 워크포스 › 에이전트 상세의 "연결 설정" 상시 섹션.
 * 기존 "MCP Config" 섹션은 `freshApiKey`(방금 재발급)가 있을 때만 렌더돼, 온보딩 위저드를
 * 벗어나면 연결 구조(.mcp.json 등)를 다시 볼 방법이 아예 없었다 — 이 컴포넌트는 그 갭을
 * 메운다. `GET /api/agents/{id}/connection-artifact`는 재발급 없이 언제든 안전하게 호출
 * 가능(응답 `api_key`는 항상 null, `.mcp.json`의 키 자리는 서버가 placeholder로 채운다) —
 * fetchWithAuth 필수(축③ 그라운딩 — bare fetch는 세션 만료 시 복구 없이 401로 죽는다).
 */
export function AgentConnectionSettingsSection({ agentId, freshApiKey }: AgentConnectionSettingsSectionProps) {
  const t = useTranslations('settings');
  const to = useTranslations('onboarding');
  const tc = useTranslations('common');

  const [files, setFiles] = useState<ArtifactFile[] | null>(null);
  const [transport, setTransport] = useState<Transport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [hostedUnavailable, setHostedUnavailable] = useState(false);
  const [copied, setCopied] = useState(false);
  // story #3986(클래스 «거짓 성공 표시») — 옛 코드는 실패를 삼키고 아무 표시도
  // 안 했다(성공 표시는 안 됐지만 실패 안내도 없어 사용자가 원인을 모른다).
  const [copyFailed, setCopyFailed] = useState(false);

  const fetchArtifact = useCallback(async (reqTransport?: Transport) => {
    setError(false);
    try {
      const qs = reqTransport ? `?transport=${reqTransport}` : '';
      const res = await fetchWithAuth(`/api/agents/${agentId}/connection-artifact${qs}`);
      if (!res.ok) {
        if (reqTransport === 'http' && res.status === 400) {
          setHostedUnavailable(true);
          return;
        }
        setError(true);
        return;
      }
      const json = await res.json() as { data?: ConnectionArtifactResponse } & Partial<ConnectionArtifactResponse>;
      const payload = json.data ?? json;
      const nextFiles = payload.files ?? [];
      setFiles(nextFiles);
      const mcpFile = nextFiles.find((f) => f.filename === '.mcp.json');
      if (mcpFile) setTransport((cur) => cur ?? inferTransport(mcpFile.content));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    setLoading(true);
    void fetchArtifact();
  }, [fetchArtifact]);

  const handleSwitchTransport = (next: Transport) => {
    if (next === transport) return;
    setTransport(next);
    setLoading(true);
    void fetchArtifact(next);
  };

  const mcpFile = files?.find((f) => f.filename === '.mcp.json') ?? null;
  const otherFiles = files?.filter((f) => f.filename !== '.mcp.json') ?? [];
  const displayConfig = mcpFile
    ? (freshApiKey ? renderArtifact(mcpFile.content, freshApiKey, true) : mcpFile.content)
    : null;

  const handleCopy = async () => {
    if (!displayConfig) return;
    const toCopy = freshApiKey ? renderArtifact(mcpFile?.content ?? null, freshApiKey, false) : displayConfig;
    if (!toCopy) return;
    const result = await copyTextSafely(toCopy);
    if (!result.ok) {
      setCopyFailed(true);
      return;
    }
    setCopyFailed(false);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <DetailCard data-testid="agent-detail-card-connection" title={t('agentMcpTitle')} description={t('agentMcpDescription')}>
        {transport && (
          // story 4912 (C2a): the hosted / local choice is two ds buttons that say which one is on (aria-pressed) — no bare tags, no bg-muted pill
          <div role="group" aria-label={t('agentMcpTitle')} className="flex max-w-xs gap-1 rounded-ds-control border border-ds-line bg-ds-surface-sunk p-1">
            <Button
              variant={transport === 'http' ? 'secondary' : 'quiet'}
              aria-pressed={transport === 'http'}
              onClick={() => handleSwitchTransport('http')}
              className="flex-1"
              iconStart={<Cloud className="h-3.5 w-3.5" aria-hidden />}
            >
              {to('transportHosted')}
            </Button>
            <Button
              variant={transport === 'stdio' ? 'secondary' : 'quiet'}
              aria-pressed={transport === 'stdio'}
              onClick={() => handleSwitchTransport('stdio')}
              className="flex-1"
              iconStart={<Terminal className="h-3.5 w-3.5" aria-hidden />}
            >
              {to('transportLocal')}
            </Button>
          </div>
        )}

        {loading ? (
          <Skeleton className="h-24" />
        ) : error ? (
          <p className="text-ds-small text-ds-failed">{t('agentMcpLoadError')}</p>
        ) : isHostedUnavailableAndNoFile(hostedUnavailable, mcpFile) ? (
          <p className="text-ds-small text-ds-ink-3">{t('agentMcpHostedUnavailable')}</p>
        ) : mcpFile ? (
          <div className="overflow-hidden rounded-ds-control border border-ds-line">
            <div className="flex items-center justify-between gap-2 border-b border-ds-line bg-ds-surface-sunk px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-ds-ink-3" aria-hidden />
                <span className="font-mono text-ds-mono-md text-ds-ink">.mcp.json</span>
              </div>
              <Button variant="secondary" onClick={() => void handleCopy()} className="shrink-0">
                {copied ? <><Check className="h-3.5 w-3.5" />{to('copied')}</> : <><Copy className="h-3.5 w-3.5" />{to('copyConfig')}</>}
              </Button>
            </div>
            <pre className="overflow-x-auto bg-ds-surface-sunk p-3 text-ds-mono-md leading-relaxed">
              <code className="font-mono">{displayConfig ? <HighlightedJson text={displayConfig} /> : null}</code>
            </pre>
            {/* story #3986 — 실패 시 freshApiKey가 있으면 화면엔 마스킹판만
                있어 클립보드용 실 config와 다르다 — 선택 가능한 실 config를
                노출한다(유나 지시 — 별도 안내 줄은 안 만든다, 실패 문구가
                이미 지시). */}
            {copyFailed ? (
              <div className="space-y-1.5 border-t border-ds-line p-3">
                <p role="alert" className="text-ds-small text-ds-failed">{tc('copyFailedSelectManually')}</p>
                {freshApiKey ? (
                  <Textarea
                    readOnly
                    value={renderArtifact(mcpFile?.content ?? null, freshApiKey, false) ?? ''}
                    onFocus={(e) => e.currentTarget.select()}
                    className="resize-none p-2 font-mono"
                    rows={4}
                    data-testid="agent-connection-settings-copy-failed-raw-config"
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {!loading && !error && (
          <p className="text-ds-small text-ds-ink-3">
            {freshApiKey ? t('agentMcpFreshKeyNote') : t('agentMcpPlaceholderNote')}
          </p>
        )}

        {otherFiles.map((f) => (
          <div key={f.filename} className="overflow-hidden rounded-ds-control border border-ds-line">
            <div className="border-b border-ds-line bg-ds-surface-sunk px-3 py-2">
              <span className="font-mono text-ds-mono-md text-ds-ink">{f.filename}</span>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap bg-ds-surface-sunk p-3 text-ds-mono-md leading-relaxed">{f.content}</pre>
          </div>
        ))}
    </DetailCard>
  );
}

function isHostedUnavailableAndNoFile(hostedUnavailable: boolean, mcpFile: ArtifactFile | null): boolean {
  return hostedUnavailable && !mcpFile;
}

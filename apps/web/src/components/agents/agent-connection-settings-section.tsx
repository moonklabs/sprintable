'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Copy, Cloud, Terminal, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/lib/db/client';
import { HighlightedJson, inferTransport, renderArtifact, type Transport } from '@/app/onboarding/connect-step';

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

  const [files, setFiles] = useState<ArtifactFile[] | null>(null);
  const [transport, setTransport] = useState<Transport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [hostedUnavailable, setHostedUnavailable] = useState(false);
  const [copied, setCopied] = useState(false);

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
    try {
      await navigator.clipboard.writeText(toCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard failure
    }
  };

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{t('agentMcpTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('agentMcpDescription')}</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-3">
        {transport && (
          <div className="flex gap-0 rounded-md border border-border bg-muted p-[3px] max-w-xs">
            <button
              type="button"
              onClick={() => handleSwitchTransport('http')}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors',
                transport === 'http' && 'bg-background text-foreground shadow-sm',
              )}
            >
              <Cloud className="h-3.5 w-3.5" aria-hidden />
              {to('transportHosted')}
            </button>
            <button
              type="button"
              onClick={() => handleSwitchTransport('stdio')}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors',
                transport === 'stdio' && 'bg-background text-foreground shadow-sm',
              )}
            >
              <Terminal className="h-3.5 w-3.5" aria-hidden />
              {to('transportLocal')}
            </button>
          </div>
        )}

        {loading ? (
          <div className="h-24 animate-pulse rounded-md bg-muted" />
        ) : error ? (
          <p className="text-xs text-destructive">{t('agentMcpLoadError')}</p>
        ) : isHostedUnavailableAndNoFile(hostedUnavailable, mcpFile) ? (
          <p className="text-xs text-muted-foreground">{t('agentMcpHostedUnavailable')}</p>
        ) : mcpFile ? (
          <div className="overflow-hidden rounded-md border border-border">
            <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="font-mono text-xs text-foreground">.mcp.json</span>
              </div>
              <Button variant="outline" size="sm" onClick={() => void handleCopy()} className="shrink-0">
                {copied ? <><Check className="h-3.5 w-3.5" />{to('copied')}</> : <><Copy className="h-3.5 w-3.5" />{to('copyConfig')}</>}
              </Button>
            </div>
            <pre className="overflow-x-auto bg-muted/40 p-3 text-xs leading-relaxed">
              <code className="font-mono">{displayConfig ? <HighlightedJson text={displayConfig} /> : null}</code>
            </pre>
          </div>
        ) : null}

        {!loading && !error && (
          <p className="text-xs text-muted-foreground">
            {freshApiKey ? t('agentMcpFreshKeyNote') : t('agentMcpPlaceholderNote')}
          </p>
        )}

        {otherFiles.map((f) => (
          <div key={f.filename} className="overflow-hidden rounded-md border border-border">
            <div className="border-b border-border bg-muted px-3 py-2">
              <span className="font-mono text-xs text-foreground">{f.filename}</span>
            </div>
            <pre className="overflow-x-auto bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap">{f.content}</pre>
          </div>
        ))}
      </SectionCardBody>
    </SectionCard>
  );
}

function isHostedUnavailableAndNoFile(hostedUnavailable: boolean, mcpFile: ArtifactFile | null): boolean {
  return hostedUnavailable && !mcpFile;
}

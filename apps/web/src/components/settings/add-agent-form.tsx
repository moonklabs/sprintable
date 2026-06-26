'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, CheckCircle2 } from 'lucide-react';
import { OperatorInput } from '@/components/ui/operator-control';
import { OperatorDropdownSelect } from '@/components/ui/operator-dropdown-select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface NewAgentResult {
  name: string;
  fakechat_port: number | null;
  mcp_config: Record<string, unknown> | null;
  api_key: string | null;
}

interface AddAgentFormProps {
  projects: { id: string; name: string }[];
  /** 생성 성공 시 — 부모 agents 목록 갱신/토스트. */
  onCreated?: () => void;
  /** 결과 phase '완료' — 모달 닫기 등. */
  onDone?: () => void;
}

/**
 * 0c1a81b6 — 에이전트 추가 v2 단일 진입(모달 임베드). 2-phase: 입력(name·role·scope) → 결과(API 키·MCP).
 * org-agent S5 scope 인지 생성(`/api/agents`). settings 인라인 폼서 추출(경로 통일).
 */
export function AddAgentForm({ projects, onCreated, onDone }: AddAgentFormProps) {
  const t = useTranslations('settings');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [scopeMode, setScopeMode] = useState<'org' | 'projects'>('projects');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NewAgentResult | null>(null);
  const [mcpCopied, setMcpCopied] = useState(false);

  const toggleProject = (id: string) =>
    setProjectIds((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));

  const handleAdd = async () => {
    if (!name.trim()) return;
    if (scopeMode === 'projects' && projectIds.length === 0) return;
    setAdding(true);
    setError(null);
    try {
      // org-agent S5: org-level scope 생성(/api/agents). org_id·인가는 BE verified context.
      // scope_mode='org'면 project_ids 무시.
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          role,
          scope_mode: scopeMode,
          project_ids: scopeMode === 'projects' ? projectIds : [],
        }),
      });
      if (res.ok) {
        const json = await res.json() as { data?: { fakechat_port?: number | null; mcp_config?: Record<string, unknown> | null; api_key?: string | null } };
        setResult({
          name: name.trim(),
          fakechat_port: json.data?.fakechat_port ?? null,
          mcp_config: json.data?.mcp_config ?? null,
          api_key: json.data?.api_key ?? null,
        });
        setName('');
        setRole('member');
        setScopeMode('projects');
        setProjectIds([]);
        onCreated?.();
      } else {
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        setError(json?.error?.message ?? t('agentActionFailed'));
      }
    } catch {
      setError(t('agentActionFailed'));
    } finally {
      setAdding(false);
    }
  };

  const handleCopyMcp = async () => {
    if (!result?.mcp_config) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(result.mcp_config, null, 2));
      setMcpCopied(true);
      setTimeout(() => setMcpCopied(false), 2000);
    } catch {
      /* noop */
    }
  };

  // ── 결과 phase ──
  if (result) {
    return (
      <div className="space-y-4">
        <div className="space-y-3 rounded-md border border-success-border bg-success-tint p-4">
          <p className="text-sm font-semibold text-success">{result.name} 생성 완료</p>
          {result.fakechat_port ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="info">SSE</Badge>
              <span className="font-mono text-foreground">Port: {result.fakechat_port}</span>
              <span className="text-muted-foreground">— fakechat http://localhost:{result.fakechat_port}/sse</span>
            </div>
          ) : null}
          {result.api_key ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-foreground">API Key — 지금만 표시됩니다.</p>
              <code className="block break-all rounded border border-border bg-background p-2 font-mono text-xs text-foreground/80">
                {result.api_key}
              </code>
            </div>
          ) : null}
          {result.mcp_config ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-foreground">MCP Config (SSE)</p>
                <Button variant="glass" size="sm" onClick={() => void handleCopyMcp()}>
                  {mcpCopied ? <Check className="size-3" /> : 'Copy'}
                </Button>
              </div>
              <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground/80">
                {JSON.stringify(result.mcp_config, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
        <div className="flex justify-end">
          <Button variant="hero" onClick={() => { setResult(null); onDone?.(); }}>
            완료
          </Button>
        </div>
      </div>
    );
  }

  // ── 입력 phase ──
  return (
    <div className="space-y-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('agentNameLabel')}</label>
        <OperatorInput value={name} onChange={(e) => setName(e.target.value)} placeholder={t('agentNamePlaceholder')} />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('agentRoleLabel')}</label>
        <OperatorDropdownSelect
          value={role}
          onValueChange={(v) => setRole(v as 'member' | 'admin')}
          options={[
            { value: 'member', label: t('agentRoleMember') },
            { value: 'admin', label: t('agentRoleAdmin') },
          ]}
        />
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">{t('agentScopeLabel')}</label>
        <div className="grid gap-3 md:grid-cols-2">
          {(['org', 'projects'] as const).map((mode) => {
            const selected = scopeMode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setScopeMode(mode)}
                className={`rounded-md border px-4 py-4 text-left transition ${selected ? 'border-primary/40 bg-primary/10' : 'border-border bg-muted/30 hover:bg-muted'}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{mode === 'org' ? t('agentScopeAllProjects') : t('agentScopeSpecificProjects')}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{mode === 'org' ? t('agentScopeAllProjectsBody') : t('agentScopeSpecificProjectsBody')}</p>
                  </div>
                  {selected ? <CheckCircle2 className="size-5 shrink-0 text-primary" /> : null}
                </div>
              </button>
            );
          })}
        </div>

        {scopeMode === 'projects' ? (
          <div className="grid max-h-72 gap-3 overflow-y-auto md:grid-cols-2 xl:grid-cols-3">
            {projects.map((project) => {
              const selected = projectIds.includes(project.id);
              return (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => toggleProject(project.id)}
                  className={`rounded-md border px-4 py-4 text-left transition ${selected ? 'border-primary/40 bg-primary/10' : 'border-border bg-muted/30 hover:bg-muted'}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-sm font-semibold text-foreground">{project.name}</p>
                    {selected ? <CheckCircle2 className="size-5 shrink-0 text-primary" /> : null}
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            {t('agentScopeAllProjectsHint', { count: projects.length })}
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{t('agentSeatCaption')}</p>

      <div className="flex justify-end">
        <Button
          variant="hero"
          size="lg"
          onClick={() => void handleAdd()}
          disabled={!name.trim() || (scopeMode === 'projects' && projectIds.length === 0) || adding}
        >
          {adding ? '...' : t('addAgent')}
        </Button>
      </div>
    </div>
  );
}

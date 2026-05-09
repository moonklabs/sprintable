'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

interface ExecutionLogItem {
  id: string;
  rule_id: string | null;
  rule_name: string | null;
  event_type: string;
  trigger_type_slug: string | null;
  target_agent_id: string | null;
  agent_name: string | null;
  status: string;
  error_message: string | null;
  duration_ms: number | null;
  created_at: string;
}

interface ExecutionLogResponse {
  items: ExecutionLogItem[];
  total: number;
  offset: number;
  limit: number;
}

const LIMIT = 20;

function statusVariant(status: string): 'secondary' | 'destructive' | 'outline' {
  if (status === 'completed') return 'secondary';
  if (status === 'failed') return 'destructive';
  return 'outline';
}

export function WorkflowExecutionHistorySection({ projectId }: { projectId: string }) {
  const t = useTranslations('settings');

  const [logs, setLogs] = useState<ExecutionLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetch = async (off: number) => {
    if (!projectId) return;
    setLoading(true);
    try {
      const res = await window.fetch(
        `/api/workflow-executions?project_id=${projectId}&offset=${off}&limit=${LIMIT}`
      );
      if (res.ok) {
        const json = await res.json() as ExecutionLogResponse;
        setLogs(json.items ?? []);
        setTotal(json.total ?? 0);
        setOffset(off);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void fetch(0); }, [projectId]);

  const hasPrev = offset > 0;
  const hasNext = offset + LIMIT < total;

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{t('workflowExecutionHistory')}</h2>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-3">
        {loading ? (
          <p className="text-sm text-muted-foreground">...</p>
        ) : logs.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            {t('workflowNoExecutions')}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">{t('workflowCreatedAt')}</th>
                    <th className="pb-2 pr-4 font-medium">{t('workflowEventType')}</th>
                    <th className="pb-2 pr-4 font-medium">{t('workflowMatchedRule')}</th>
                    <th className="pb-2 pr-4 font-medium">{t('workflowTargetAgent')}</th>
                    <th className="pb-2 font-medium">{t('workflowStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <>
                      <tr
                        key={log.id}
                        className="border-b border-border/50 cursor-pointer hover:bg-muted/30"
                        onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                      >
                        <td className="py-2 pr-4 text-muted-foreground whitespace-nowrap">
                          {new Date(log.created_at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </td>
                        <td className="py-2 pr-4">
                          <code className="rounded bg-muted px-1 py-0.5">{log.event_type}</code>
                        </td>
                        <td className="py-2 pr-4 text-foreground">{log.rule_name ?? <span className="text-muted-foreground">—</span>}</td>
                        <td className="py-2 pr-4 text-foreground">{log.agent_name ?? <span className="text-muted-foreground">—</span>}</td>
                        <td className="py-2">
                          <Badge variant={statusVariant(log.status)}>{log.status}</Badge>
                        </td>
                      </tr>
                      {expandedId === log.id && log.error_message ? (
                        <tr key={`${log.id}-err`} className="border-b border-border/50 bg-destructive/5">
                          <td colSpan={5} className="px-2 py-2 text-xs text-destructive">
                            {log.error_message}
                          </td>
                        </tr>
                      ) : null}
                    </>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-muted-foreground">
                {offset + 1}–{Math.min(offset + LIMIT, total)} / {total}
              </span>
              <div className="flex gap-2">
                <Button variant="glass" size="sm" disabled={!hasPrev} onClick={() => void fetch(offset - LIMIT)}>
                  ‹
                </Button>
                <Button variant="glass" size="sm" disabled={!hasNext} onClick={() => void fetch(offset + LIMIT)}>
                  ›
                </Button>
              </div>
            </div>
          </>
        )}
      </SectionCardBody>
    </SectionCard>
  );
}

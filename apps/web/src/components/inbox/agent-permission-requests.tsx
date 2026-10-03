'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { fetchWithAuth } from '@/lib/db/client';
import { permissionLine, stillShown, waitedMinutes, type PermissionRequest } from '@/lib/agent-permissions';

/**
 * story #4533 (E-DESKTOP-2 B-2 · 명세 모음 «B-2 폰 권한 요청 카드(웹은 읽기 전용)») — the approvals inbox's top group «에이전트 권한
 * 요청»: an agent waiting at a permission prompt on its computer, sent to the person who decides it. The web only looks (no device
 * key to sign with): the button place holds one line — the phone · the window passed · the computer gone quiet · no paired phone.
 * Read again every 15 s while a request is shown (the computer coming back or an answer from the phone changes the card).
 */
const REFRESH_MS = 15_000;

async function readRequests(): Promise<PermissionRequest[] | null> {
  try {
    const res = await fetchWithAuth('/api/agent-permission-requests');
    if (!res.ok) return null;
    const body = (await res.json()) as { requests?: PermissionRequest[] };
    return Array.isArray(body.requests) ? body.requests : null;
  } catch {
    return null;
  }
}

export function AgentPermissionRequests() {
  const t = useTranslations('agentPermissions');
  const [requests, setRequests] = useState<PermissionRequest[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const shown = (requests ?? []).filter((r) => stillShown(r, now));
  const waiting = shown.length > 0;

  // read on mount, then again every 15 s while something is shown; a failed read keeps what was shown
  useEffect(() => {
    let off = false;
    const read = () => void readRequests().then((list) => {
      if (off) return;
      setRequests((prev) => list ?? prev ?? []);
      setNow(Date.now());
    });
    if (requests === null) read();
    const id = waiting ? setInterval(read, REFRESH_MS) : null;
    return () => { off = true; if (id) clearInterval(id); };
  }, [waiting]); // eslint-disable-line react-hooks/exhaustive-deps -- `requests` only gates the first read

  if (shown.length === 0) return null; // nothing waiting: the inbox as it was

  return (
    <section className="mb-4 space-y-2" aria-labelledby="agent-permission-requests-title" data-testid="agent-permission-requests">
      <h2 id="agent-permission-requests-title" className="text-xs font-semibold text-muted-foreground">
        {t('groupTitle')} · {shown.length}
      </h2>
      {shown.map((r) => <PermissionCard key={r.id} request={r} now={now} />)}
    </section>
  );
}

function PermissionCard({ request: r, now }: { request: PermissionRequest; now: number }) {
  const t = useTranslations('agentPermissions');
  const line = permissionLine(r);
  const notes = [r.masked ? t('maskedNote') : null, r.truncated ? t('truncatedNote') : null].filter(Boolean);
  return (
    <article className="flex flex-col gap-1.5 rounded-xl border border-border bg-card px-4 py-3" data-testid="agent-permission-card">
      <div className="flex w-full flex-wrap items-center gap-1.5">
        {line === 'unknown' ? (
          <Badge variant="chip" className="border-dashed text-muted-foreground">{t('chipUnknown')}</Badge>
        ) : (
          <Badge variant="chip">{t('chip')}</Badge>
        )}
        {line === 'unknown' ? null : (
          <span className="text-[11px] text-muted-foreground">{t('waited', { n: waitedMinutes(r, now) })}</span>
        )}
      </div>
      <p className="text-sm text-foreground">{[r.agent_name, r.device_name].filter(Boolean).join(' · ')}</p>
      {r.role ? <p className="text-xs text-muted-foreground">{t('role', { role: r.role })}</p> : null}
      <p className="font-mono text-xs text-foreground">{r.tool}</p>
      <div className="rounded-md bg-muted/50 px-2 py-1.5">
        <p className="break-all font-mono text-xs text-foreground">{r.summary}</p>
        {notes.length > 0 ? <p className="mt-0.5 text-[11px] text-muted-foreground">{notes.join(' · ')}</p> : null}
      </div>
      {r.workdir ? <p className="text-[11px] text-muted-foreground">{t('workdir', { path: r.workdir })}</p> : null}
      <p className="text-xs text-muted-foreground" data-testid="agent-permission-line">
        {line === 'expired' ? t('line.expired')
          : line === 'unknown' ? t('line.unknown')
            : line === 'noPairedPhone' ? t('line.noPairedPhone')
              : t('line.answerOnPhone')}
      </p>
    </article>
  );
}

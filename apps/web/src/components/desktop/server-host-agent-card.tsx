'use client';

// story 5024 (AC4) — on a workspace SERVER HOST (a headless Linux server a team runs itself) there is no Mac app to download and no «app on this Mac» to open: the screens that said so
// («에이전트는 내 Mac에서 돌아가요» · «이 Mac에 앱이 있나요?» · «지금은 받을 수 없어요») left the person who set the server up with no way to see how an agent gets attached. This card is that way:
// one command for the computer that will run the agent (the server itself or a teammate's), with the server's own public address filled in by the server (`origin` is handed down from a server
// component — never read from the browser's location), a copy button, and what happens next. The command is a literal on its own line — never inside a translated sentence.
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ds/card';
import { Button } from '@/components/ui/button';
import { copyTextSafely } from '@/lib/clipboard';

/** where the newest Linux download of the host is listed (public; its `url` is the tarball, whose own install guide says the install and pairing order) — a literal, like the command: never inside a translated sentence */
export const SERVER_HOST_DOWNLOAD_LIST = 'https://storage.googleapis.com/sprintable-desktop-releases/linux-server-host/latest/manifest.json';

/** the one command: `~/work` is the folder the agent works in (the host's `pair` needs one) — the card says it may be changed */
export function serverHostPairCommand(origin: string): string {
  return `sprintable-host pair --folder ~/work --server ${origin}`;
}

export function ServerHostAgentCard({ origin, hideTitle = false, testId = 'server-host-agent-card' }: { origin: string; hideTitle?: boolean; testId?: string }) {
  const t = useTranslations('desktop.serverHostAgent');
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const command = serverHostPairCommand(origin);
  const copy = async () => {
    const result = await copyTextSafely(command);
    if (!result.ok) { setState('failed'); return; }
    setState('copied');
    setTimeout(() => setState('idle'), 2000);
  };
  return (
    <Card className="space-y-3 p-4" data-testid={testId}>
      {hideTitle ? null : <p className="text-ds-card-title font-semibold text-ds-ink">{t('title')}</p>}
      <p className="break-keep text-sm text-muted-foreground">{t('lead')}</p>
      <div className="space-y-1">
        <p className="text-xs font-medium text-ds-ink-2">{t('commandLabel')}</p>
        <code className="block break-all rounded border border-ds-line bg-ds-surface px-2 py-1 font-mono text-ds-small text-ds-ink-2 select-all" data-testid={`${testId}-command`}>{command}</code>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={copy} data-testid={`${testId}-copy`}>{state === 'copied' ? t('copied') : t('copy')}</Button>
          {state === 'failed' ? <span className="text-xs text-muted-foreground" role="status" data-testid={`${testId}-copy-failed`}>{t('copyFailed')}</span> : null}
        </div>
      </div>
      <p className="break-keep text-xs text-muted-foreground" data-testid={`${testId}-folder-note`}>{t('folderNote')}</p>
      <p className="break-keep text-sm text-foreground" data-testid={`${testId}-after`}>{t('afterLead')}</p>
      <p className="break-keep text-xs text-muted-foreground" data-testid={`${testId}-install-note`}>{t('installNote')}</p>
      <div className="space-y-1">
        <p className="text-xs font-medium text-ds-ink-2">{t('installListLabel')}</p>
        <code className="block break-all rounded border border-ds-line bg-ds-surface px-2 py-1 font-mono text-ds-small text-ds-ink-2 select-all" data-testid={`${testId}-install-list`}>{SERVER_HOST_DOWNLOAD_LIST}</code>
      </div>
    </Card>
  );
}

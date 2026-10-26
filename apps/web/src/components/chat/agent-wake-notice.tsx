'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, Copy, Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { copyTextSafely } from '@/lib/clipboard';
import { useFlatHref } from '@/hooks/use-flat-href';
import type { AgentWakeTarget } from '@/lib/chat/agent-wake';

/**
 * story #4761 (D3) — under the message a person just sent, when an agent it goes to has no way to hear it: no webhook, no live
 * gateway stream (the bare hosted MCP reads Sprintable only while it calls a tool). Said plainly instead of a «typing» that was
 * never true: what to do (tell it once, in the terminal where it runs — the sentence is one tap to copy) and the way that needs
 * no nudge (the Mac app: its daemon pushes the message in). Info tone — nothing failed, the message is delivered.
 */
export function AgentWakeNotice({ targets }: { targets: AgentWakeTarget[] }) {
  const t = useTranslations('chats');
  const flatHref = useFlatHref();
  const [copied, setCopied] = useState(false);
  if (targets.length === 0) return null;
  const first = targets[0]!;
  const firstName = first.name || t('agentWakeUnnamed');
  const prompt = t('agentWakePrompt');
  const lead = targets.length === 1
    ? t('agentWakeLeadOne', { name: firstName })
    : t('agentWakeLeadMany', { name: firstName, n: targets.length - 1 });
  return (
    <div
      data-testid="agent-wake-notice"
      role="status"
      className="mx-2 mt-1 flex items-start gap-2.5 rounded-xl border border-info-border bg-info-tint px-3.5 py-2.5 text-left"
    >
      <Info className="mt-0.5 h-[18px] w-[18px] shrink-0 text-info" aria-hidden />
      <div className="min-w-0 space-y-1.5">
        <p className="text-sm text-foreground">{lead}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-background px-2 py-1 font-mono text-xs text-foreground">&ldquo;{prompt}&rdquo;</span>
          <Button
            variant="outline"
            size="sm"
            data-testid="agent-wake-copy"
            onClick={() => { void copyTextSafely(prompt).then((r) => { if (r.ok) { setCopied(true); setTimeout(() => setCopied(false), 2000); } }); }}
          >
            {copied ? <><Check className="h-3.5 w-3.5" />{t('agentWakeCopied')}</> : <><Copy className="h-3.5 w-3.5" />{t('agentWakeCopy')}</>}
          </Button>
        </div>
        <p className="text-sm text-foreground">
          {t('agentWakeApp')}{' '}
          <Link
            href={flatHref('/desktop')}
            data-testid="agent-wake-app-link"
            className="inline-flex items-center gap-1 rounded text-xs font-medium text-info underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('agentWakeAppLink')}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </p>
      </div>
    </div>
  );
}

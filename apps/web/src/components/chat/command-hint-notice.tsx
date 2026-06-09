'use client';

import Link from 'next/link';
import { ArrowRight, Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { runtimeLabel } from '@/lib/runtime-capabilities';

/**
 * S4 capability gate가 발신자 응답(`command_gate.blocked[]`)으로 돌려주는 차단 hint 1건.
 * BE는 facts(agent_name·command·runtime_type)만 제공 — 자연어 대안 카피는 FE가 i18n으로 구성.
 */
export interface BlockedHint {
  agent_id: string;
  agent_name: string;
  runtime_type: string | null;
  command: string;
  reason: string;
}

/**
 * 미지원 런타임 에이전트에 슬래시 커맨드를 보냈을 때 timeline에 렌더되는 가이드 카드.
 * 참여자 버블(아바타+말풍선)과 구별되는 inset 시스템 notice — info 톤(에러 아닌 친절한 리디렉션).
 */
export function CommandHintNotice({ hint }: { hint: BlockedHint }) {
  const t = useTranslations('chats');
  // S8 #1: 런타임 표기 — claude-code→"Claude Code"·미등록→원값·null→"런타임 미설정"(i18n).
  const runtime = runtimeLabel(hint.runtime_type) ?? t('runtimeUnsetLabel');
  return (
    <div className="mx-2 flex items-start gap-2.5 rounded-xl border border-info-border bg-info-tint px-3.5 py-2.5">
      <Info className="mt-0.5 h-[18px] w-[18px] shrink-0 text-info" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="text-sm text-foreground">
          {t('commandBlockedLead', { agentName: hint.agent_name, runtime })}
        </p>
        <p className="text-sm text-muted-foreground">
          {t('commandBlockedAlt', { command: hint.command })}
        </p>
        <Link
          href={`/settings/members/agents/${hint.agent_id}`}
          className="inline-flex items-center gap-1 rounded text-xs font-medium text-info underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('commandBlockedSettings')}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

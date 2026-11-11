'use client';

import Link from 'next/link';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { useTranslations } from 'next-intl';
import { runtimeLabel } from '@/lib/runtime-capabilities';
import { useFlatHref } from '@/hooks/use-flat-href';

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
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const t = useTranslations('chats');
  // S8 #1: 런타임 표기 — claude-code→"Claude Code"·미등록→원값·null→"런타임 미설정"(i18n).
  const runtime = runtimeLabel(hint.runtime_type) ?? t('runtimeUnsetLabel');
  return (
    <div className="mx-2" data-testid="command-hint-notice">
      <Banner
        tone="info"
        action={(
          <Button asChild variant="quiet">
            <Link href={flatHref(`/organization/workforce/${hint.agent_id}`)}>
              {t('commandBlockedSettings')}
              <Icon name="arrow_forward" size={14} aria-hidden />
            </Link>
          </Button>
        )}
      >
        <p className="text-ds-body text-ds-ink">{t('commandBlockedLead', { agentName: hint.agent_name, runtime })}</p>
        <p className="text-ds-body text-ds-ink-2">{t('commandBlockedAlt', { command: hint.command })}</p>
      </Banner>
    </div>
  );
}

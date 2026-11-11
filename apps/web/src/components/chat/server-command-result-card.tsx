'use client';

// story #92f00dc4(Chat ②층·P1·FE, doc exec-command-final-spec-92f00dc4) — 서버가 직접
// 집행한 카탈로그 커맨드(done/assign/priority, #9a5abc24 BE)의 결과 카드. #5c29454b의
// 3존 텍스트 추출 유틸(extractLeadSentence·extractNextAction)만 재사용하고, 컴포넌트
// 자체는 새로 둔다 — ReportMessageSummary는 밀도 게이트(8줄/400자)로 접힘을 결정하는데
// 이 카드의 실제 회신 문구는 대부분 그보다 훨씬 짧아(예: "'/done' 완료 — ...") 그 레일을
// 그대로 태우면 카드 자체가 안 뜬다(폴딩 대상이 아니라 «항상 뜨는» 카드가 맞다).
import { useTranslations } from 'next-intl';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { Chip } from '@/components/ds/chip';
import type { IconName } from '@/components/ds/icon';
import { extractLeadSentence, extractNextAction } from '@/lib/chat-report-density';
import type { ChatMessage } from '@/hooks/use-chat-sse';

type ServerCommand = NonNullable<ChatMessage['server_command']>;

interface ServerCommandResultCardProps {
  content: string;
  serverCommand: ServerCommand;
  /** story #92f00dc4 §🎯 — 모호 후보 클릭. 없으면(구 렌더 경로 등) 후보 행이 그냥 비-클릭형
   * 텍스트로만 뜬다(기능 저하일 뿐 에러 아님). */
  onFillComposer?: (text: string) => void;
}

// story 4887 (UI-4 P4-c) — the outcome used to be a colour dot alone; it is now a ds chip: icon + WORDS (colour never carries the meaning by itself — WCAG 1.4.1).
// `ambiguous` is the one that asks for a hand (a candidate must be picked); a wrong usage / nothing found is neutral — neither a success nor a confirmed failure.
const OUTCOME: Record<ServerCommand['outcome'], { icon: IconName; tone: 'done' | 'failed' | 'needs-hand' | 'neutral' }> = {
  executed: { icon: 'check_circle', tone: 'done' },
  denied: { icon: 'block', tone: 'failed' },
  not_found: { icon: 'help', tone: 'neutral' },
  ambiguous: { icon: 'warning', tone: 'needs-hand' },
  invalid_args: { icon: 'edit_note', tone: 'neutral' },
};

/** story 4847 (AC-명령) — the one machine reason this card knows (the server's `server_command.code`); any other value draws the card as before */
export const ROOM_HAS_NO_PROJECT = 'ROOM_HAS_NO_PROJECT';

export function ServerCommandResultCard({ content, serverCommand, onFillComposer }: ServerCommandResultCardProps) {
  const t = useTranslations('chats');
  // the server's sentence for this code is English and only a fallback: the words shown are ours (what did not work + the way that does)
  const roomHasNoProject = serverCommand.outcome === 'denied' && serverCommand.code === ROOM_HAS_NO_PROJECT; // the server sends it only with `denied`; the code on any other outcome is not this card
  const lead = roomHasNoProject ? t('serverCommandRoomHasNoProject', { command: serverCommand.command }) : extractLeadSentence(content);
  const nextAction = serverCommand.outcome === 'executed' ? extractNextAction(content) : null;
  // story #92f00dc4/페드루 판정(PR #3549 리뷰 후속) — candidates는 BE가 outcome='ambiguous'일
  // 때만 구조화 배열로 싣는다(문장 comma-split 금지). 필드 부재(구서버·BE 델타 미착지)면
  // 후보 존 자체를 생략 — 지어내지 않는다.
  const candidates = serverCommand.outcome === 'ambiguous' ? serverCommand.candidates : undefined;
  // story #92f00dc4(PR #3552 페드루 리뷰 후속) — target_story_number 없이 `/assign 채영1`만
  // 채우면 BE가 「채영1」을 스토리 ref로 오인해 invalid_args로 떨어진다(#9a5abc24 소델타
  // 대기, 디디 몫). 필드 부재면 채움 자체를 막는다 — 깨진 커맨드를 채우느니 기능 저하.
  const targetStoryNumber = serverCommand.outcome === 'ambiguous' ? serverCommand.target_story_number : undefined;
  const canFillCandidate = Boolean(onFillComposer) && targetStoryNumber != null;

  const outcome = OUTCOME[serverCommand.outcome];
  const outcomeWords: Record<ServerCommand['outcome'], string> = {
    executed: t('serverCommandOutcomeExecuted'),
    denied: t('serverCommandOutcomeDenied'),
    not_found: t('serverCommandOutcomeNotFound'),
    ambiguous: t('serverCommandOutcomeAmbiguous'),
    invalid_args: t('serverCommandOutcomeInvalidArgs'),
  };

  return (
    <Card data-testid="server-command-card" data-outcome={serverCommand.outcome} className="min-w-0 max-w-full px-3 py-2 text-ds-body [overflow-wrap:anywhere]">
      {/* ⚡ 서버 집행 배지 — 기존 「런타임 커맨드」 버블(chat-bubble.tsx isCmd 분기, 사람이 입력한 /명령을 에이전트가 처리)과 구분: 이 카드는 발화자가 «서버»다.
          결과는 점 하나(색만)이던 것을 아이콘 + 글 칩으로. */}
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <Chip icon="bolt">{t('serverCommandBadge')}</Chip>
        <Chip tone={outcome.tone} icon={outcome.icon} data-testid="server-command-outcome">{outcomeWords[serverCommand.outcome]}</Chip>
      </div>

      <p className="mb-1 text-ds-body font-medium leading-relaxed">{lead}</p>

      {candidates && candidates.length > 0 ? (
        <>
          <p className="mb-1 mt-2 text-ds-small font-semibold text-ds-ink-2">
            {t('serverCommandCandidatesLabel')}
          </p>
          <ul className="flex flex-col gap-0.5">
            {candidates.map((name) => (
              <li key={name}>
                <Button
                  variant="quiet"
                  onClick={() => canFillCandidate && onFillComposer?.(`/${serverCommand.command} #${targetStoryNumber} ${name}`)}
                  disabled={!canFillCandidate}
                  className="h-auto w-full justify-start whitespace-normal px-1.5 py-1 text-left font-normal"
                >
                  {name}
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {roomHasNoProject ? (
        <div className="mt-2.5" data-testid="server-command-way">
          <Banner tone="info">
            <span className="font-semibold">{t('serverCommandWayLabel')}</span>
            <span className="text-ds-small"> {t('serverCommandRoomHasNoProjectWay')}</span>
          </Banner>
        </div>
      ) : null}

      {nextAction ? (
        <div className="mt-2.5">
          <Banner tone="info">
            <span className="font-semibold">{t('reportNextActionLabel')}</span>
            <span className="text-ds-small"> {nextAction}</span>
          </Banner>
        </div>
      ) : null}
    </Card>
  );
}

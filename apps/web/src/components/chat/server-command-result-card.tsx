'use client';

// story #92f00dc4(Chat ②층·P1·FE, doc exec-command-final-spec-92f00dc4) — 서버가 직접
// 집행한 카탈로그 커맨드(done/assign/priority, #9a5abc24 BE)의 결과 카드. #5c29454b의
// 3존 텍스트 추출 유틸(extractLeadSentence·extractNextAction)만 재사용하고, 컴포넌트
// 자체는 새로 둔다 — ReportMessageSummary는 밀도 게이트(8줄/400자)로 접힘을 결정하는데
// 이 카드의 실제 회신 문구는 대부분 그보다 훨씬 짧아(예: "'/done' 완료 — ...") 그 레일을
// 그대로 태우면 카드 자체가 안 뜬다(폴딩 대상이 아니라 «항상 뜨는» 카드가 맞다).
import { useTranslations } from 'next-intl';
import { Zap } from 'lucide-react';
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

const DOT_CLASS_BY_OUTCOME: Record<ServerCommand['outcome'], string> = {
  executed: 'bg-success',
  denied: 'bg-destructive',
  not_found: 'bg-muted-foreground',
  ambiguous: 'bg-warning',
  // invalid_args — 사용법 오류. 권한/존재 여부와 다른 축이라 성공도 실패-확定도 아닌 중립.
  invalid_args: 'bg-muted-foreground',
};

export function ServerCommandResultCard({ content, serverCommand, onFillComposer }: ServerCommandResultCardProps) {
  const t = useTranslations('chats');
  const lead = extractLeadSentence(content);
  const nextAction = serverCommand.outcome === 'executed' ? extractNextAction(content) : null;
  // story #92f00dc4/페드루 판정(PR #3549 리뷰 후속) — candidates는 BE가 outcome='ambiguous'일
  // 때만 구조화 배열로 싣는다(문장 comma-split 금지). 필드 부재(구서버·BE 델타 미착지)면
  // 후보 존 자체를 생략 — 지어내지 않는다.
  const candidates = serverCommand.outcome === 'ambiguous' ? serverCommand.candidates : undefined;

  return (
    <div className="min-w-0 max-w-full rounded-xl bg-proof-panel px-3.5 py-2 text-sm text-foreground [overflow-wrap:anywhere]">
      {/* ⚡ 서버 집행 배지 — 기존 「런타임 커맨드」 버블(chat-bubble.tsx isCmd 분기, 사람이
          입력한 /명령을 에이전트가 처리)과 구분: 이 카드는 발화자가 «서버»다. */}
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-bold text-proof-ink-2">
          <Zap className="size-2.5 text-warning" aria-hidden />
          {t('serverCommandBadge')}
        </span>
        <span className={`size-1.5 shrink-0 rounded-full ${DOT_CLASS_BY_OUTCOME[serverCommand.outcome]}`} aria-hidden />
      </div>

      <p className="mb-1 text-sm font-medium leading-relaxed">{lead}</p>

      {candidates && candidates.length > 0 ? (
        <>
          <p className="mb-1 mt-2 text-[9.5px] font-bold uppercase tracking-wide text-muted-foreground">
            {t('serverCommandCandidatesLabel')}
          </p>
          <ul className="flex flex-col gap-0.5">
            {candidates.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  onClick={() => onFillComposer?.(`/${serverCommand.command} ${name}`)}
                  disabled={!onFillComposer}
                  className="w-full rounded px-1.5 py-1 text-left text-sm leading-relaxed hover:bg-brand/10 disabled:cursor-default disabled:hover:bg-transparent"
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {nextAction ? (
        <div className="mt-2.5 flex gap-2 rounded-lg border border-brand/15 bg-brand/10 px-2.5 py-2">
          <span className="font-bold text-brand" aria-hidden>→</span>
          <p className="[overflow-wrap:anywhere]">
            <span className="font-semibold text-primary">{t('reportNextActionLabel')}</span>
            <span className="text-[12.5px] text-foreground"> {nextAction}</span>
          </p>
        </div>
      ) : null}
    </div>
  );
}

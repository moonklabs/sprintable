import { cn } from '@/lib/utils';

/**
 * story #3049(2984-S1, doc diff-axis-2984-color-to-material-inventory §4) — 에이전트 정체성
 * 마킹 재질 프리미티브. soft-fill 색 배경(`bg-proof-blue-soft`)으로 "이건 에이전트다"를
 * 표시하던 ~9곳(아바타 배경 4·Bot 칩 5)을 헤어라인 컨테이너 + proof-blue 신호 dot/마크로
 * 통일한다 — «에이전트» 자체는 여전히 신호라 dot/마크의 색(proof-blue)은 KEEP(제거 아님,
 * §1 판별: 지우면 "에이전트임"이 안 읽히므로 신호).
 *
 * 두 형태:
 * - `AgentSignalDot` — dot 자체(story-card.tsx agent dot 등 이미 dot인 자리는 그대로 KEEP,
 *   여기선 재사용 편의를 위해서만 내보낸다).
 * - `AgentIdentity` — "Bot" 텍스트 칩(inbox·add-participant-modal·chat-bubble·
 *   new-conversation-modal 4곳이 지금까지 각자 복붙해온 `bg-proof-blue-soft` 배지의
 *   단일 대체 정의).
 * - `AGENT_MARK_FILL_CLASS` — 아바타/아이콘류 배경 원·사각(story-card.tsx 멤버 아바타·
 *   avatar.tsx 이니셜 배경+AI 코너배지·trust-seal.tsx claimed 아이콘·lib/storage/format.ts의
 *   avatarColor 헬퍼) 4곳이 채택하는 배경 클래스 — 이 4곳은 이미 각자 자기 경계(ring 또는
 *   border-proof-blue)를 갖고 있어(§2 형태 신호 문법, 호출부마다 다른 모양) 새 border를
 *   더하지 않는다. fill만 투명으로 교체하는 것이 "SHIFT"의 정확한 범위(단일 정의 재사용,
 *   사본 분화 금지).
 */
export const AGENT_MARK_FILL_CLASS = 'bg-transparent text-proof-blue';

export function AgentSignalDot({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('inline-block size-1.5 shrink-0 rounded-full bg-proof-blue', className)} />;
}

export function AgentIdentity({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border border-proof-line px-1 py-0.5 text-[9px] font-medium text-muted-foreground',
        className,
      )}
    >
      <AgentSignalDot />
      Bot
    </span>
  );
}

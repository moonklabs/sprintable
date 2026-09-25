import { Bot, UserRound } from 'lucide-react';

// story #4284(유나 판정) — 이름 없는 구성원의 머리글자 자리. 공용 Avatar(#4638)와 같은 규칙: 에이전트는 Bot · 사람은 UserRound.
// 이름이 없다는 사실만으로 사람 아이콘을 그리면 에이전트가 사람처럼 보인다(보드 카드는 에이전트 점까지 붙어 두 신호가 어긋났다).
export function UnnamedMemberIcon({ type, className = 'size-3' }: { type: string | null | undefined; className?: string }) {
  return type === 'agent'
    ? <Bot className={className} aria-hidden="true" />
    : <UserRound className={className} aria-hidden="true" />;
}

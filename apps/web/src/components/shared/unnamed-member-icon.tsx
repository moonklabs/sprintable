import { Bot, User, type LucideProps } from 'lucide-react';

// story #4284(유나 · PO 판정) — 이름 없는 구성원의 신원 폴백 아이콘 한 벌의 정본: 에이전트는 Bot · 사람은 User.
// 공용 Avatar의 아이콘 단계 · 신뢰 화면 PersonMark · TrustSeal · 보드 카드 · 담당자 고르기가 모두 이걸 쓴다(자리마다 고르면 갈라진다 —
// 이름이 없다는 것만으로 사람 아이콘을 그려 에이전트가 사람처럼 보인 자리가 있었다). 크기는 className 또는 style로 — 기본은 «둘러싼 동그라미의 절반»(`size-1/2`: 24 칸 → 12 · 20 칸 → 10)이라 아바타 크기를 따라간다(story 5048 ④ PO 11-27: 고정 size-3 걷음). 동그라미는 너비 · 높이가 정해진 칸이어야 한다.
export function UnnamedMemberIcon({ type, className = 'size-1/2', ...rest }: { type: string | null | undefined } & LucideProps) {
  const Icon = type === 'agent' ? Bot : User;
  return <Icon className={className} aria-hidden="true" {...rest} />;
}

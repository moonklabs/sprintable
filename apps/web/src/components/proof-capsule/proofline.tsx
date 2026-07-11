import { cn } from '@/lib/utils';

export type ProofState = 'blue' | 'amber' | 'green' | 'red';

const RAIL_COLOR: Record<ProofState, string> = {
  blue: 'bg-proof-blue',
  amber: 'bg-proof-amber',
  green: 'bg-proof-green',
  red: 'bg-proof-red',
};

interface ProoflineProps {
  state: ProofState;
  className?: string;
}

/**
 * Proof Capsule FE 스펙 §1 — 좌측 4px 수직 레일. 상태 4색(blue/amber/green/red)만 표시하고
 * 텍스트 라벨은 담지 않는다(색만으로 의미 전달 금지 — 본문 state 텍스트가 항상 병기).
 */
export function Proofline({ state, className }: ProoflineProps) {
  return <div className={cn('w-1 shrink-0 self-stretch', RAIL_COLOR[state], className)} aria-hidden="true" />;
}

import { FolderOpen } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

// story #2842(0b17472c 그라운딩, PO 확定) — 항목이 뷰어의 활성 프로젝트와 다른 프로젝트
// 소속일 때만 병기(같으면 null이라 이 컴포넌트 자체가 안 그려짐 — 노이즈 절제). 병기 값은
// BE가 주는 project_slug 그대로(별도 표시용 프로젝트명 필드는 이 계약에 없음).
// story #2858 — loop-queue-client.tsx도 이 컴포넌트를 그대로 재사용한다(export). 페드루 PO
// 판정(2026-08-21, 2851 교훈 적용) — 별개 페이지라도 표시 컴포넌트는 단일 정의를 유지한다
// (로컬 재정의는 중복 정의 규율 위반).
// story #3870(PO 확定 2026-09-14 12:32Z) — 옛 org-briefing이 「오늘」로 흡수(SID:3831·
// e7359201ca)되며 이 컴포넌트가 있던 attention-cluster-board.tsx의 유일한 살아있는 소비처가
// loop-queue-client.tsx뿐이 됐다(AttentionClusterBoard 자체는 소비처 0 — 은퇴 잔재로 삭제).
// CrossProjectTag만 자기 파일로 옮겨 그 의존을 끊는다(회귀 0 — 재사용 규율 그대로 유지).
export function CrossProjectTag({ label }: { label: string | null }) {
  if (!label) return null;
  return <Badge variant="chip" className="shrink-0 gap-1"><FolderOpen className="size-3 shrink-0" aria-hidden />{label}</Badge>;
}

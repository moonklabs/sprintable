// story #2955 §4에서 docs-index.tsx StatusChip이 처음 정한 doc.status 색 매핑을 #2963(공유
// 네비 레일 v2)이 그대로 재사용하려 공유 모듈로 끌어올렸다(발명 0 — "1호 인덱스 StatusChip과
// 같은 doc.status 소스" 스펙 요구 그대로). 값 자체는 무변경 — 위치만 옮김.
export type DocStatusFilter = 'draft' | 'pending' | 'confirmed' | 'denied';

// story #2955 §4 — 대비 주의(실측 대비표): 소형 텍스트에 계열색을 직접 못 씀(라이트 AA
// 미달 위험) — 칩은 배경(soft)+상태 라벨어 병기, dot만 순색.
export const DOC_STATUS_TONE: Record<DocStatusFilter, { bg: string; dot: string; text: string }> = {
  confirmed: { bg: 'bg-success-tint', dot: 'bg-success', text: 'text-foreground' },
  pending: { bg: 'bg-warning-tint', dot: 'bg-warning', text: 'text-foreground' },
  denied: { bg: 'bg-destructive-tint', dot: 'bg-destructive', text: 'text-foreground' },
  draft: { bg: 'bg-muted', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
};

export function toDocStatusFilter(status: string | undefined): DocStatusFilter {
  return status === 'pending' || status === 'confirmed' || status === 'denied' ? status : 'draft';
}

export function docStatusLabelKey(status: DocStatusFilter): string {
  switch (status) {
    case 'confirmed': return 'docGateConfirmed';
    case 'pending': return 'docGatePending';
    case 'denied': return 'docGateDenied';
    case 'draft': return 'indexStatusDraft';
  }
}

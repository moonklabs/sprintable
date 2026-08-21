import type { LucideIcon } from 'lucide-react';
import { FileText, File, Layers, CheckSquare, Calendar, Image, FlaskConical, Paperclip } from 'lucide-react';
import { initials } from '@/lib/storage/format';

/**
 * story #2888(S2a) — 엔티티 타입 레지스트리 SSOT(원래 embed-card.tsx에 있던 것을 이관·
 * embed-card.tsx는 재수출만 한다 — 기존 소비처 4곳(chat-input·entity-aware-textarea·
 * approval-request-card·notification-display)은 import 경로 무변경, 회귀 0).
 *
 * story #2302: 이 8종은 BE reference_registry.py ENTITY_RESOLVERS 와 키 집합이 같아야 한다
 * (AC2·AC5, entity-registry.parity.test.ts 가 코드스캔으로 대조). `asset`은 registry 밖
 * FE 전용 타입(AC5 명시 예외) — 아이콘을 **일부러** 안 준다: asset은 이미지/PDF/영상 등
 * content-type이 제각각이라 타입 레벨 단일 아이콘이 의미가 없고(개별 파일 아이콘은
 * getFileIcon이 파일별로 처리), "아이콘 없으면 이름 글자로"가 AC4가 못박은 **기본값**이지
 * asset만의 예외 처리가 아니다 — 그래서 이 fallback은 `resolveEntityIcon()`이 모든 타입에
 * 공통 적용한다(Hash 캐치올을 버림 — 있지도 않은 아이콘을 그리는 거짓보다 글자가 정직하다).
 *
 * ⛔story #2263(C-7, 2026-07-29) — 한 번 여기 chat_message를 추가했다가 되돌렸다: BE
 * ENTITY_RESOLVERS에 등록하면 «완전지원 엔티티»(검색·MCP mention·project축 parity까지)를
 * 전부 갖춰야 한다는 게 CI 13건 실패로 드러났다(PO 판정). chat_message는 참조 TARGET은
 * 되지만 그 다섯 계약을 구조적으로 다 못 갖춰(검색대상 아님·project축 아님·단독조회
 * 라우트 없음) `reference_registry.TARGET_ONLY_TYPES`라는 별도 집합으로 옮겨졌다 —
 * ENTITY_RESOLVERS 밖이라 이 FE parity 대조에도 안 걸린다(의도적으로 안 나타난다).
 *
 * **신규 타입 추가 지점**(S2h — gate/PR/member): BE reference_registry.py ENTITY_RESOLVERS에
 * 새 타입을 등록하면 이 두 레지스트리(ENTITY_ICONS·ENTITY_COLORS)와 embed-card.tsx의
 * getEntityHref·ENTITY_API도 같이 넓혀야 parity 테스트가 통과한다.
 */
export const ENTITY_ICONS: Record<string, LucideIcon> = {
  story: FileText,
  doc: File,
  epic: Layers,
  task: CheckSquare,
  sprint: Calendar,
  artifact: Image,
  hypothesis: FlaskConical,
  evidence: Paperclip,
};

/** ENTITY_ICONS에 없는 타입(지금은 asset뿐) → 아이콘 대신 이름 첫 글자(들). 예외 처리 아님(위 주석). */
export function resolveEntityIcon(entityType: string): LucideIcon | null {
  return ENTITY_ICONS[entityType] ?? null;
}

/** 아이콘이 없는 타입(asset)의 렌더 지점 3곳(모달 헤더·EmbedCard·EntityChip)이 각자 Hash로
 * 캐치올하지 않고 한 곳에서 초성/이니셜 폴백을 공유하게 — 새 타입이 추가돼도 렌더 지점마다
 * 따로 안 고쳐도 된다. Icon은 호출부에서 미리 resolve해 prop으로 받는다(레포 관례 —
 * storage-file-glyph.tsx 동일 주석: 컴포넌트 스코프 안에서 lookup한 컴포넌트를 바로 JSX로 쓰면
 * `react-hooks/static-components`에 걸린다). */
export function EntityGlyph({ Icon, label, className }: { Icon: LucideIcon | null; label: string; className?: string }) {
  if (Icon) return <Icon className={className ?? 'size-4 shrink-0'} />;
  return <span className={`flex items-center justify-center text-[10px] font-bold ${className ?? 'size-4 shrink-0'}`}>{initials(label)}</span>;
}

// 엔티티 신호 토큰(하드코딩 blue/purple/emerald/slate 제거·다크 자동 정합). 타입별 절제 틴트.
// ⛔AC4: ②/③(담긴 곳으로 보내거나 갈 곳이 없는) 상태에서는 이 틴트를 쓰지 않고 GRAY_STATE_COLOR로
// 덮어쓴다(회색 하나로 통일 — 노랑 금지 근거는 그 상수 주석 참고). 여기 있는 색은 **①일 때만** 보인다.
export const ENTITY_COLORS: Record<string, string> = {
  story: 'border-info/30 bg-info/8 text-foreground',
  doc: 'border-border bg-muted/40 text-foreground',
  epic: 'border-secondary bg-secondary/40 text-foreground',
  task: 'border-success/30 bg-success/8 text-foreground',
  sprint: 'border-warning/30 bg-warning/8 text-foreground',
  artifact: 'border-info/30 bg-info/8 text-foreground',
  hypothesis: 'border-border bg-muted/40 text-foreground',
  evidence: 'border-border bg-muted/40 text-foreground',
  // S6: 스토리지 자산 토큰 — info 틴트(파일 아이콘은 content-type 의존이라 AssetEmbedCard 에서 getFileIcon 처리).
  asset: 'border-info/30 bg-info/8 text-foreground',
};

// ⛔AC4 색 규율: 노랑 금지 — 노랑은 "기다리면 풀리는 것"인데 ②/③은 사용자가 기다려서 풀 수
// 있는 상태가 아니다(담긴 곳으로 보내거나, 애초에 갈 곳이 없는 것). 구별은 색이 아니라 말로.
export const GRAY_STATE_COLOR = 'border-border bg-muted/40 text-muted-foreground';

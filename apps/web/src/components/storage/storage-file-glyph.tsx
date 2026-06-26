import type { LucideIcon } from 'lucide-react';

/**
 * 아이콘을 prop 으로 받아 렌더 — `getFileIcon()` 호출 결과(LucideIcon)를 렌더 스코프 상단에서
 * 직접 JSX 로 쓰면 `react-hooks/static-components` 가 걸린다(레포 chat-bubble 동일 패턴: prop 전달).
 */
export function StorageFileGlyph({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return <Icon className={className} />;
}

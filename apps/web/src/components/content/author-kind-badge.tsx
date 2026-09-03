import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';

/**
 * story #3368 §6-3-1(유나 실측·정정 2026-09-03) — 목록의 "작성 주체"는 평문이 아니라
 * 칩(배지)이어야 한다는 것이 시안 S1의 명시 규격이자 스토리 AC1 본문("원작성 주체 ·
 * 최종 수정 주체를 확인할 수 있다")이다. 평문 텍스트로는 목록을 훑을 때 "누가 썼나"가
 * 눈에 안 걸린다 — 이 제품의 차별점(에이전트가 채운다)이 목록에서 사라지는 실사고였다.
 * `variant="chip"`(중립 정보, 성공/경고 등 의미론 없음)을 원작성·최종수정 두 자리 모두
 * 같은 컴포넌트로 써서 드리프트를 막는다.
 */
export function AuthorKindBadge({ kind }: { kind: 'agent' | 'human' | null | undefined }) {
  const t = useTranslations('content');
  if (kind !== 'agent' && kind !== 'human') {
    return <span className="text-muted-foreground">{t('originAuthorUnknown')}</span>;
  }
  return <Badge variant="chip">{kind === 'agent' ? t('authorAgent') : t('authorHuman')}</Badge>;
}

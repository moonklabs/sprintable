import { actorRowLabels, memberLookup } from '@/lib/member-display';

/**
 * [SID:4311 PR 3] 스탠드업 스토리 담당 칩 라벨 — 스탠드업 화면 두 목록 · 피드백 창 연결 스토리가 같은 규칙.
 * 예전 `assignee_name ?? t('unknown')`는 담당 없음 · 표에 없음 · 이름 빔을 «알 수 없음» 하나로 뭉갰다(4286 부류).
 * - 담당 없음 → «담당자 없음»(board.unassigned와 같은 낱말 · 호출부가 넘김)
 * - 담당 있음 → 이름 · 이름 빔 «이름 없는 구성원» · 표에 없음 «알 수 없는 구성원» · 표를 받는 중 빈 글자(memberLookup)
 * - 한 목록 안 같은 이름 서로 다른 담당 둘 → «· ID 앞 8자»(담당 id마다 한 번 · 꼬리 규칙은 member-display 한 곳)
 */
export function storyAssigneeChipLabels(
  stories: ReadonlyArray<{ assignee_id?: string | null }>,
  table: Readonly<Record<string, string | null | undefined>>,
  tc: (key: string) => string,
  unassignedLabel: string,
  opts: { loaded: boolean } = { loaded: true },
): (assigneeId: string | null | undefined) => string {
  const base = (id: string) => memberLookup(table, id, tc, opts)?.label ?? '';
  const labels = actorRowLabels(stories.map((s) => ({ id: s.assignee_id ?? null, label: s.assignee_id ? base(s.assignee_id) : null })));
  return (id) => (id ? labels.get(id) ?? base(id) : unassignedLabel);
}

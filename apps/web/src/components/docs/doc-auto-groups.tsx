'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ds/button';
import { SectionHeader } from '@/components/ds/section-header';
import { TreeRow } from '@/components/ds/tree-row';
import { cn } from '@/lib/utils';
import { bucketDocsByTime, computeDocGroups, type DocGroup, type GroupableDoc } from './lib/doc-groups';
import { DOC_STATUS_TONE, toDocStatusFilter } from './lib/doc-status-tone';

// story #2963 §3 — proof 상태 도트(6px). 색은 도트에만(§4 대비 규율) — 라벨 텍스트는 무변경.
function StatusDot({ status }: { status: string | undefined }) {
  const tone = DOC_STATUS_TONE[toDocStatusFilter(status)];
  return <span className={cn('size-1.5 shrink-0 rounded-full', tone.dot)} aria-hidden="true" />;
}

// story #2193 — "자동 묶음" 뷰. 기존 DocTree(폴더 계층·드래그 이동)는 그대로 두고, 이건
// 완전히 별개의 읽기전용 브라우징 뷰다. 폴더에 담겼는지와 무관하게 slug 접두어로 문서를
// 평면적으로 재배열해 보여준다 — 그래서 여기엔 드래그/폴더 이동 UI가 없다(그라운딩:
// "폴더에 담으라고 권하는 UI는 만들지 않는다" — 그릇이 있어도 담김은 57%에 그쳤으므로).

interface DocAutoGroupsProps {
  docs: GroupableDoc[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  inFolderLabel: string;
  looseAtRootLabel: string;
  thisMonthLabel: string;
  lastMonthLabel: string;
  olderLabel: string;
  unknownDateLabel: string;
  moreLabel: (count: number) => string;
  /** 테스트용 주입 지점 — 생략하면 렌더 시점의 실제 시각을 쓴다. bucketDocsByTime이 순수함수로
   * now를 받게 설계된 것과 같은 이유(월 경계에서 실행 시점에 따라 결과가 흔들리는 테스트를 피함). */
  now?: Date;
}

// AC3 "2단 접힘" — 그룹 하나가 e-canvas처럼 17개만 되어도 접힌 헤더 하나로 시작하고, 펼쳐도
// 한 번에 다 쏟아지지 않게 CAP개까지만 보여준 뒤 "N개 더"로 나머지를 연다.
const MEMBER_CAP = 8;

function GroupMemberList({ members, moreLabel, selectedSlug, onSelect }: {
  members: GroupableDoc[];
  moreLabel: (count: number) => string;
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? members : members.slice(0, MEMBER_CAP);
  const hiddenCount = members.length - visible.length;

  return (
    <ul>
      {visible.map((doc) => (
        <li key={doc.id}>
          {/* story 4892 (UI-9 문서 트리) — 묶음 안 문서 줄 = ds TreeRow(잎). 상태 점 · 문서 아이콘 · 제목 · 열린 문서 aria-current는 그대로. 끌기 · «⋮»는 이 읽기 전용 보기엔 없다(그대로). */}
          <TreeRow
            depth={0}
            title={doc.title}
            icon="description"
            statusMark={<StatusDot status={doc.status} />}
            selected={selectedSlug === doc.slug}
            controlProps={{ onClick: () => onSelect(doc.slug) }}
          />
        </li>
      ))}
      {hiddenCount > 0 && (
        <li>
          <Button variant="quiet" onClick={() => setExpanded(true)} className="w-full justify-start">
            {moreLabel(hiddenCount)}
          </Button>
        </li>
      )}
    </ul>
  );
}

function GroupHeader({ group, inFolderLabel, looseAtRootLabel, moreLabel, selectedSlug, onSelect }: {
  group: DocGroup;
  inFolderLabel: string;
  looseAtRootLabel: string;
  moreLabel: (count: number) => string;
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = group.inFolder.length + group.looseAtRoot.length;
  // AC5 — 담김/안 담김이 둘 다 있을 때만 구분 서브헤더를 보여준다. 한쪽이 0이면(예: e-canvas는
  // 전량 폴더 밖) 굳이 "0개" 서브헤더를 만들지 않고 그냥 평면 나열한다.
  const showSplit = group.inFolder.length > 0 && group.looseAtRoot.length > 0;

  return (
    <div>
      {/* story 4892 — 묶음 머리 = ds SectionHeader(접는 머리글 = 단추 · aria-expanded · 제목 + 건수). 한글 이름이라 mono · uppercase는 쓰지 않는다(2967 결함 그대로 피함). */}
      <SectionHeader
        title={group.label}
        count={<span className="text-ds-small text-ds-ink-3">{total}</span>}
        collapsed={!expanded}
        onToggle={() => setExpanded((v) => !v)}
        level={3}
      />
      {expanded && (
        <div className="space-y-1.5 pb-1 pl-4 pt-1">
          {showSplit ? (
            <>
              <div>
                <p className="px-2.5 pb-0.5 text-ds-small text-ds-ink-3">{inFolderLabel} · {group.inFolder.length}</p>
                <GroupMemberList members={group.inFolder} moreLabel={moreLabel} selectedSlug={selectedSlug} onSelect={onSelect} />
              </div>
              <div>
                <p className="px-2.5 pb-0.5 text-ds-small text-ds-ink-3">{looseAtRootLabel} · {group.looseAtRoot.length}</p>
                <GroupMemberList members={group.looseAtRoot} moreLabel={moreLabel} selectedSlug={selectedSlug} onSelect={onSelect} />
              </div>
            </>
          ) : (
            <GroupMemberList members={[...group.inFolder, ...group.looseAtRoot]} moreLabel={moreLabel} selectedSlug={selectedSlug} onSelect={onSelect} />
          )}
        </div>
      )}
    </div>
  );
}

// story #2193 후속(#2505 착지로 created_at 확보) — 약한 접두어 문서(369건급)를 시간
// 그릇으로 세분화한다. 반드시 created_at 기준(수정일 아님) — 이유 셋은 doc-groups.ts의
// bucketDocsByTime 주석 참고. unknownDate는 "이전"에 조용히 묻히지 않고 별도 그룹으로
// 노출한다(created_at 누락/파싱 실패를 숨기지 않기 위함).
function timeBucketGroups(ungrouped: GroupableDoc[], now: Date, labels: {
  thisMonthLabel: string; lastMonthLabel: string; olderLabel: string; unknownDateLabel: string;
}): DocGroup[] {
  const { thisMonth, lastMonth, older, unknownDate } = bucketDocsByTime(ungrouped, now);
  const buckets: Array<[string, string, GroupableDoc[]]> = [
    ['this-month', labels.thisMonthLabel, thisMonth],
    ['last-month', labels.lastMonthLabel, lastMonth],
    ['older', labels.olderLabel, older],
    ['unknown-date', labels.unknownDateLabel, unknownDate],
  ];
  return buckets
    .filter(([, , members]) => members.length > 0)
    .map(([key, label, members]) => ({ key, label, inFolder: [], looseAtRoot: members }));
}

export function DocAutoGroups({
  docs, selectedSlug, onSelect, inFolderLabel, looseAtRootLabel,
  thisMonthLabel, lastMonthLabel, olderLabel, unknownDateLabel, moreLabel, now: nowProp,
}: DocAutoGroupsProps) {
  const { groups, ungrouped } = useMemo(() => computeDocGroups(docs), [docs]);
  // 마운트 시점 1회만 고정 — 렌더마다 "이번 달" 경계가 흔들리지 않게(그리고 doc-groups.ts의
  // bucketDocsByTime이 now를 주입받는 순수함수로 설계된 이유와 같은 결). nowProp이 있으면
  // (테스트) 그걸 쓰고, 없으면(실제 렌더) 마운트 시점 시각을 한 번만 잡는다.
  const now = useMemo(() => nowProp ?? new Date(), [nowProp]);
  const timeGroups = useMemo(
    () => timeBucketGroups(ungrouped, now, { thisMonthLabel, lastMonthLabel, olderLabel, unknownDateLabel }),
    [ungrouped, now, thisMonthLabel, lastMonthLabel, olderLabel, unknownDateLabel],
  );

  return (
    <nav>
      {groups.map((group) => (
        <GroupHeader key={group.key} group={group} inFolderLabel={inFolderLabel} looseAtRootLabel={looseAtRootLabel} moreLabel={moreLabel} selectedSlug={selectedSlug} onSelect={onSelect} />
      ))}
      {timeGroups.map((group) => (
        <GroupHeader key={group.key} group={group} inFolderLabel={inFolderLabel} looseAtRootLabel={looseAtRootLabel} moreLabel={moreLabel} selectedSlug={selectedSlug} onSelect={onSelect} />
      ))}
    </nav>
  );
}

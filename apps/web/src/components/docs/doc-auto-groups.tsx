'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { computeDocGroups, type DocGroup, type GroupableDoc } from './lib/doc-groups';

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
  restLabel: string;
  moreLabel: (count: number) => string;
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
    <ul className="space-y-0.5">
      {visible.map((doc) => (
        <li key={doc.id}>
          <button
            type="button"
            onClick={() => onSelect(doc.slug)}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
              selectedSlug === doc.slug
                ? 'bg-primary/10 text-primary'
                : 'text-foreground/80 hover:bg-muted hover:text-foreground',
            )}
          >
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{doc.title}</span>
          </button>
        </li>
      ))}
      {hiddenCount > 0 && (
        <li>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-full rounded-lg px-2.5 py-1 text-left text-[11px] text-primary hover:underline"
          >
            {moreLabel(hiddenCount)}
          </button>
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
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-foreground/90 hover:bg-muted"
      >
        {expanded ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="flex-1 truncate">{group.label}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">{total}</span>
      </button>
      {expanded && (
        <div className="space-y-1.5 pb-1 pl-4">
          {showSplit ? (
            <>
              <div>
                <p className="px-2.5 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{inFolderLabel} · {group.inFolder.length}</p>
                <GroupMemberList members={group.inFolder} moreLabel={moreLabel} selectedSlug={selectedSlug} onSelect={onSelect} />
              </div>
              <div>
                <p className="px-2.5 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground opacity-75">{looseAtRootLabel} · {group.looseAtRoot.length}</p>
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

export function DocAutoGroups({ docs, selectedSlug, onSelect, inFolderLabel, looseAtRootLabel, restLabel, moreLabel }: DocAutoGroupsProps) {
  const { groups, ungrouped } = useMemo(() => computeDocGroups(docs), [docs]);

  return (
    <nav className="space-y-0.5">
      {groups.map((group) => (
        <GroupHeader key={group.key} group={group} inFolderLabel={inFolderLabel} looseAtRootLabel={looseAtRootLabel} moreLabel={moreLabel} selectedSlug={selectedSlug} onSelect={onSelect} />
      ))}
      {ungrouped.length > 0 && (
        // story #2193 AC2/AC6 — 원래는 여기가 시간 버킷(이번 달/지난 달/이전)으로 세분화될
        // 자리다. backend DocSummaryResponse에 created_at이 아직 없어(스키마 확인 완료,
        // updated_at만 있음, 후속 PR #2505에서 추가 중) 지금은 하나로 묶어 두고, 필드가
        // 오면 이 슬롯 안에서만 세분화하면 된다 — 그룹 배치 구조 자체는 이미 맞춰져 있다.
        //
        // ⚠️ 다음 사람에게: 그때 반드시 created_at 기준으로 나눌 것 — updated_at이 아니다.
        // 이유 셋(유나양 판정):
        //  ① 에이전트 오염 회피 — updated_at 기준이면 에이전트가 방금 건드린 문서가 위로
        //     온다. 사람이 안 봤는데 상단에 서는 "거짓 최신성"이 된다.
        //  ② 훑기의 안정적 척추 — 버킷이 매번 바뀌면 "어디 있더라"가 안 된다. created_at은
        //     한번 정해지면 안 변해 고정된 기준이 된다.
        //  ③ 역할 분리 — 위쪽 "최근 본 것"(RecentsSection)이 이미 사람의 열람 최신성 축을
        //     담당한다. 시간 버킷까지 updated_at이면 그 축이 두 번 겹친다.
        <GroupHeader
          group={{ key: 'ungrouped', label: restLabel, inFolder: [], looseAtRoot: ungrouped }}
          inFolderLabel={inFolderLabel}
          looseAtRootLabel={looseAtRootLabel}
          moreLabel={moreLabel}
          selectedSlug={selectedSlug}
          onSelect={onSelect}
        />
      )}
    </nav>
  );
}

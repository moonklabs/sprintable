'use client';

import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { fetchWithAuth } from '@/lib/db/client';
import { getEntityHref } from '@/components/chat/embed-card';
import type { BacklinkItem } from '@/components/shared/entity-backlinks-section';

// story #3560(제작 작업대 컨셉 카드, 페드루 PO 確定 2026-09-06 — 화면 자리 ④ 채택: 새
// 화면 0) — 컨셉 카드=Doc(§3560 FE 조각 確定 ①-c). 「이것을 가리키는 것들」
// (EntityBacklinksSection)과 같은 API(`/api/stories/{id}/backlinks`)를 그대로 재사용
// 하되(새 엔드포인트 0), `source_type==='doc'`만 걸러 별 블록으로 보인다 — 검증
// 시트(EvidenceSection)와 자리를 안 섞는다. 참조 doc이 있을 때만 그린다(§5-2 "없는
// 길을 그리지 않는다"의 반대축 — 여기서는 "없음"을 문구로 말하지 않고 블록 자체를
// 안 그리는 쪽, 유나 §17-24 확定).
//
// story #3584(페드루 PO 確定 2026-09-06, 3573 라이브 표본 GET에서 발견) — 3573
// 표본이 실제로 드러낸 갭: concept_approval 게이트로 승인되는 doc은 본문에 스토리를
// «멘션»하지 않는 한 backlinks에 0건으로 남는다(게이트의 neutral_facts.doc_title/
// sealed_doc_id 경로로만 연결되지, 텍스트 참조 관계가 아니다). 그래서 데이터 소스를
// backlinks doc ∪ 이 work item의 concept_approval 게이트가 물고 있는 sealed_doc_id/
// sealed_doc_title(story #3569 additive)로 넓힌다 — 같은 doc이 두 경로 다로 잡히면
// id로 중복 제거. 표시 조건은 그대로(합집합이 0건이면 블록 자체를 안 그린다).
//
// gates는 story-detail-panel.tsx가 이미 fetch해 둔 chipGates를 그대로 prop으로
// 받는다(PO 確定 — "새 fetch 0이 이상", 게이트 목록은 상세 패널이 P0-04 in-flight
// 칩용으로 이미 물어보는 데이터라 이 블록이 또 부르면 같은 것을 두 번 묻는 셈).
interface ConceptCardDoc {
  id: string;
  title: string;
}

// #3560 GateItem(kanban/types.ts) 전체를 안 끌어오고 이 블록이 실제로 쓰는 필드만.
interface GateSealedDocItem {
  gate_type: string;
  sealed_doc_id?: string | null;
  sealed_doc_title?: string | null;
}

export function ConceptCardSection({ workItemId, gates }: { workItemId: string; gates: GateSealedDocItem[] }) {
  const t = useTranslations('board');
  const [backlinkItems, setBacklinkItems] = useState<BacklinkItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWithAuth(`/api/stories/${workItemId}/backlinks`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ data?: BacklinkItem[] }>) : null))
      .then((json) => { if (!cancelled) setBacklinkItems(json?.data ?? []); })
      .catch(() => { if (!cancelled) setBacklinkItems([]); });
    return () => { cancelled = true; };
  }, [workItemId]);

  // backlinks가 도착하기 전엔 판정하지 않는다(늦게 오는 doc이 있어도 블록이 먼저
  // 접혀 안 뜨는 것을 막는다 — §5-2 "모른다≠없다"와 같은 결). gates는 부모가 이미
  // 로드를 끝낸 값을 그대로 받으므로 여기선 null 게이팅이 필요 없다.
  if (backlinkItems === null) return null;

  const backlinkDocs: ConceptCardDoc[] = backlinkItems
    .filter((item) => item.source_type === 'doc' && item.doc)
    .map((item) => ({ id: item.doc!.id, title: item.doc!.title }));
  // PO 지적(§17-21 ①, 2026-09-06 PR#3938 CONDITIONAL) — sealed_doc_title이 없다고
  // sealed_doc_id 앞 8자(hex)를 링크 글자로 대신 그리지 않는다(사람이 읽을 낱말이
  // 아니다). title이 없으면 그 항목 자체를 뺀다.
  const gateDocs: ConceptCardDoc[] = gates
    .filter((g) => g.gate_type === 'concept_approval' && g.sealed_doc_id && g.sealed_doc_title)
    .map((g) => ({ id: g.sealed_doc_id!, title: g.sealed_doc_title! }));

  const seen = new Set<string>();
  const docs: ConceptCardDoc[] = [...backlinkDocs, ...gateDocs].filter((d) => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });
  if (docs.length === 0) return null;

  return (
    <div className="border-t border-border/60 px-4 py-3" data-testid="concept-card-section">
      <p className="mb-2 text-xs font-medium text-muted-foreground">{t('conceptCardTitle')}</p>
      <ul className="flex flex-col gap-1.5">
        {docs.map((doc) => {
          const href = getEntityHref('doc', doc.id);
          return (
            <li key={doc.id} className="flex items-start gap-2 text-xs text-foreground">
              <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              {href ? (
                <a href={href} className="[overflow-wrap:anywhere] hover:underline">{doc.title}</a>
              ) : (
                <span className="[overflow-wrap:anywhere]">{doc.title}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

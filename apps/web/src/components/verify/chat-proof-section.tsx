'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChatProofEmbed } from './chat-proof-embed';

interface ProofSnapshotMessage {
  message_id: string;
  author_id: string;
  content: string;
  created_at: string;
}

export interface StoryProofReference {
  id: string;
  createdAt: string;
  stillExists: boolean | null;
  conversationId: string;
  startMessageId: string;
  snapshot: ProofSnapshotMessage[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseSnapshot(raw: unknown): ProofSnapshotMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ProofSnapshotMessage[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return null;
    const { message_id, author_id, content, created_at } = item;
    if (
      typeof message_id !== 'string' || typeof author_id !== 'string'
      || typeof content !== 'string' || typeof created_at !== 'string'
    ) return null;
    out.push({ message_id, author_id, content, created_at });
  }
  return out;
}

export interface ParsedStoryProofReferences {
  items: StoryProofReference[];
  /** story #2265(C-7), PO 지적(2026-07-29): form="proof"·target_type="chat_message"인
   * «후보»였지만 이후 검증(payload 없음·형상 깨짐)에서 떨어져 못 그리는 항목의 id. 이걸
   * 안 세면 "대화 근거 2건"이 실은 3건 중 2건이라는 사실이 사라진다 — "모름이 «괜찮음»으로
   * 집계"되는 것을 막는다. 다른 form(mention 등)이나 다른 target_type은 애초에 이 섹션의
   * 후보가 아니므로 여기 안 들어간다(스킵 대상은 "보여줘야 했는데 못 보여준 것"만). */
  skippedIds: string[];
}

/**
 * story #2265(C-7) PR1b — `GET /api/stories/{id}/references?direction=outgoing` 응답을
 * 검증된 proof 참조 배열로. `form="proof"`·`target_type="chat_message"` 조합만 대상(다른
 * form/target은 이 화면 소관이 아니다 — 조용히 생략, no-fiction). `proof_payload`가
 * 없거나(구 BE 응답·아직 배선 前) 형상이 안 맞으면 그 항목은 렌더할 재료가 없으므로 생략한다
 * (지어내지 않음 — 항목 하나가 깨졌다고 전체를 실패시키지도 않는다). 다만 그 생략은
 * `skippedIds`로 «세어서» 남긴다(호출부가 "N건은 표시할 수 없음"을 보일 수 있게).
 */
export function parseStoryProofReferences(json: unknown): ParsedStoryProofReferences {
  const inner = isRecord(json) ? (json['data'] ?? json) : json;
  const rows = Array.isArray(inner) ? inner : [];

  const items: StoryProofReference[] = [];
  const skippedIds: string[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (row['form'] !== 'proof' || row['target_type'] !== 'chat_message') continue;
    const id = row['id'];
    const createdAt = row['created_at'];
    if (typeof id !== 'string' || typeof createdAt !== 'string') continue; // id 자체가 없으면 셀 대상도 못 됨.
    const payload = row['proof_payload'];
    const conversationId = isRecord(payload) ? payload['conversation_id'] : undefined;
    const startMessageId = isRecord(payload) ? payload['start_message_id'] : undefined;
    const snapshot = isRecord(payload) ? parseSnapshot(payload['snapshot']) : null;
    if (!isRecord(payload) || typeof conversationId !== 'string' || typeof startMessageId !== 'string' || !snapshot) {
      skippedIds.push(id);
      continue;
    }
    const stillExists = typeof row['still_exists'] === 'boolean' ? row['still_exists'] : null;
    items.push({ id, createdAt, stillExists, conversationId, startMessageId, snapshot });
  }
  return { items, skippedIds };
}

function formatCitationDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric' }).format(d);
}

interface ChatProofSectionProps {
  storyId: string;
}

/**
 * story #2265(C-7) PR1b — `EvidenceSection` 바로 아래 붙는 "대화 근거" 섹션. 참조 0건이면
 * null 렌더(EvidenceSection과 동일 관례 — 빈 섹션을 굳이 안 보임).
 *
 * ⛔이름 해소 생략: snapshot의 author_id를 팀원 이름으로 바꾸려면 별도 조회가 필요한데, 이
 * 슬라이스(PR1b-1, 읽기 전용 얹기)에는 없다 — 빈 문자열로 두어 raw UUID를 노출하지 않는
 * 쪽을 택했다(없는 것을 지어내지 않음). 후속 슬라이스에서 memberMap을 받아 채운다.
 */
export function ChatProofSection({ storyId }: ChatProofSectionProps) {
  const t = useTranslations('verify');
  const [refs, setRefs] = useState<StoryProofReference[] | null>(null);
  const [skippedCount, setSkippedCount] = useState(0);
  const [loadedForId, setLoadedForId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/stories/${storyId}/references?direction=outgoing`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled) return;
        const { items, skippedIds } = json ? parseStoryProofReferences(json) : { items: [], skippedIds: [] };
        if (skippedIds.length > 0 && process.env.NODE_ENV !== 'production') {
          // dev 전용: 다음 사람이 왜 안 뜨는지 보게(PO 지시, 2026-07-29).
          console.warn('ChatProofSection: skipped malformed proof reference(s)', { storyId, skippedIds });
        }
        setRefs(items);
        setSkippedCount(skippedIds.length);
        setLoadedForId(storyId);
      })
      .catch(() => {
        if (!cancelled) { setRefs([]); setSkippedCount(0); setLoadedForId(storyId); }
      });
    return () => { cancelled = true; };
  }, [storyId]);

  if (refs === null || loadedForId !== storyId || (refs.length === 0 && skippedCount === 0)) return null;

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-medium text-muted-foreground">
        {t('chatProofCount', { count: refs.length })}
        {/* story #2265(C-7), PO 지적(2026-07-29): 생략 건수는 반드시 세어서 말한다("모름"이
            "괜찮음"으로 집계되면 안 됨) — 정확한 문구는 유나군 lane(자리만 확保). */}
        {skippedCount > 0 ? ` · ${t('chatProofSomeUnavailable', { count: skippedCount })}` : ''}
      </p>
      {refs.map((ref) => (
        <ChatProofEmbed
          key={ref.id}
          sourceLabel={`${t('chatProofSectionTitle')} · ${formatCitationDate(ref.createdAt)}`}
          conversationHref={`/chats/${ref.conversationId}?messageId=${ref.startMessageId}`}
          quotedAt={formatCitationDate(ref.createdAt)}
          status={ref.stillExists === false ? 'deleted' : 'normal'}
          messages={ref.snapshot.map((m) => ({ id: m.message_id, senderName: '', content: m.content }))}
        />
      ))}
    </div>
  );
}

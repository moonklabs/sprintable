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

/**
 * story #2265(C-7) PR1b — `GET /api/stories/{id}/references?direction=outgoing` 응답을
 * 검증된 proof 참조 배열로. `form="proof"`·`target_type="chat_message"` 조합만 대상(다른
 * form/target은 이 화면 소관이 아니다 — 조용히 생략, no-fiction). `proof_payload`가
 * 없거나(구 BE 응답·아직 배선 前) 형상이 안 맞으면 그 항목은 렌더할 재료가 없으므로 생략한다
 * (지어내지 않음 — 항목 하나가 깨졌다고 전체를 실패시키지도 않는다).
 */
export function parseStoryProofReferences(json: unknown): StoryProofReference[] {
  const inner = isRecord(json) ? (json['data'] ?? json) : json;
  const rows = Array.isArray(inner) ? inner : [];

  const out: StoryProofReference[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (row['form'] !== 'proof' || row['target_type'] !== 'chat_message') continue;
    const id = row['id'];
    const createdAt = row['created_at'];
    if (typeof id !== 'string' || typeof createdAt !== 'string') continue;
    const payload = row['proof_payload'];
    if (!isRecord(payload)) continue; // 아직 payload가 안 실리는 BE 응답 — 이 항목은 못 그림.
    const conversationId = payload['conversation_id'];
    const startMessageId = payload['start_message_id'];
    if (typeof conversationId !== 'string' || typeof startMessageId !== 'string') continue;
    const snapshot = parseSnapshot(payload['snapshot']);
    if (!snapshot) continue;
    const stillExists = typeof row['still_exists'] === 'boolean' ? row['still_exists'] : null;
    out.push({ id, createdAt, stillExists, conversationId, startMessageId, snapshot });
  }
  return out;
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
  const [loadedForId, setLoadedForId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/stories/${storyId}/references?direction=outgoing`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled) return;
        setRefs(json ? parseStoryProofReferences(json) : []);
        setLoadedForId(storyId);
      })
      .catch(() => {
        if (!cancelled) { setRefs([]); setLoadedForId(storyId); }
      });
    return () => { cancelled = true; };
  }, [storyId]);

  if (refs === null || loadedForId !== storyId || refs.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-medium text-muted-foreground">
        {t('chatProofCount', { count: refs.length })}
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

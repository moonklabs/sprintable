import type { ChatMessage } from '@/hooks/use-chat-sse';
import { parseEntityRef } from './entity-ref';
import { resolveEmbedDecision } from './embed-renderer';

export interface TextSegment {
  kind: 'text';
  text: string;
}

export interface GroupSegment {
  kind: 'group';
  entityType: string;
  refs: Array<{ entityId: string; label: string }>;
}

export type MessageSegment = TextSegment | GroupSegment;

const SOLE_LINK_BLOCK_RE = /^\[([^\]]*)\]\(([^)]+)\)$/;

/**
 * story #2905(S2c③④) — 메시지 content를 ChatMarkdown이 그리기 전에 미리 세그먼트로 쪼갠다.
 * delta 시안(`s2c-delta-grouping-states`, PO 확定 2026-08-21) 규칙 그대로:
 *
 * 그룹 조건 = «같은 entity_type» + «sole-link(문단이 참조 하나뿐)» + «2개 이상» + «사이에
 * 산문 없음». **공백줄(빈 문단)은 안 끊는다** — `\n{2,}`로 나눈 블록 중 빈 블록은 애초에
 * 걸러지므로(filter) 공백줄만 사이에 낀 두 sole-link는 이 스캔에서 곧바로 이웃으로 보인다.
 * 산문 문단만 run을 끊는다. 다른 타입이 섞인 연속 sole-link는 entityType 일치 조건 때문에
 * 자연히 타입별 서브그룹으로 갈린다(별도 분기 불요).
 *
 * sole-link 판정 자체는 resolveEmbedDecision(allowCard:true)과 같은 SSOT — asset이나 유령
 * 참조(§EmbedRenderer 계약상 'card'가 아닌 것)는 원래도 카드가 아니던 문단이라 그룹 대상도
 * 아니다(그 문단은 그대로 일반 텍스트 세그먼트에 남아 기존 chip/asset 렌더로 떨어진다).
 */
export function segmentMessageContent(
  content: string,
  references: ChatMessage['references'],
): MessageSegment[] {
  const blocks = content.split(/\n{2,}/).filter((b) => b.trim().length > 0);

  type Classified =
    | { kind: 'prose'; raw: string }
    | { kind: 'sole-link'; raw: string; entityType: string; entityId: string; label: string };

  const classified: Classified[] = blocks.map((raw) => {
    const trimmed = raw.trim();
    const m = trimmed.match(SOLE_LINK_BLOCK_RE);
    if (!m) return { kind: 'prose', raw };
    const ref = parseEntityRef(m[2]);
    if (!ref) return { kind: 'prose', raw };
    const decision = resolveEmbedDecision(ref.entityType, ref.entityId, references, { allowCard: true });
    if (decision.kind !== 'card') return { kind: 'prose', raw };
    return { kind: 'sole-link', raw, entityType: ref.entityType, entityId: ref.entityId, label: m[1] || ref.entityId };
  });

  const segments: MessageSegment[] = [];
  let textBuffer: string[] = [];
  const flushText = () => {
    if (textBuffer.length) {
      segments.push({ kind: 'text', text: textBuffer.join('\n\n') });
      textBuffer = [];
    }
  };

  let i = 0;
  while (i < classified.length) {
    const c = classified[i]!;
    if (c.kind === 'prose') {
      textBuffer.push(c.raw);
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < classified.length) {
      const next = classified[j]!;
      if (next.kind !== 'sole-link' || next.entityType !== c.entityType) break;
      j += 1;
    }
    const run = classified.slice(i, j) as Extract<Classified, { kind: 'sole-link' }>[];
    if (run.length >= 2) {
      flushText();
      segments.push({
        kind: 'group',
        entityType: c.entityType,
        refs: run.map((r) => ({ entityId: r.entityId, label: r.label })),
      });
    } else {
      textBuffer.push(c.raw);
    }
    i = j;
  }
  flushText();
  return segments;
}

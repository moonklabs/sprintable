/**
 * HITL 승인 요청 메시지 분류 — story #2572.
 *
 * 계약 SSOT = 플러그인 `plugins/sprintable/server.ts`의 `requestApproval()`(sprintable-claude-plugin
 * 레포, 이 저장소 밖·story #2570). 그쪽을 고칠 수 없다는 하드 제약(「플러그인 변경 0」) 때문에
 * 이 파일은 그 플러그인이 이미 게시하는 고정 포맷 텍스트를 그대로 되짚는 미러 파서다 —
 * message_kind 류 구조 마커는 플러그인이 안 보내 무의미(#2572 PO 확定).
 *
 * 플러그인 원문 템플릿(server.ts:206-207):
 *   `🔒 승인 요청: \`${toolName}\`\n입력: ${inputSummary}\n\n` +
 *   `「allow」 또는 「deny <사유>」로 답해주세요 (${timeoutSec}초 내 무응답 시 자동 거부).`
 * 답변 파싱 규약(server.ts:466): `/^\s*(allow|deny)\b\s*(.*)$/i` — 이 파일이 만드는 답신 문자열은
 * 반드시 이 정규식과 왕복돼야 한다.
 *
 * 패턴이 정확히 안 맞으면 null(폴백=일반 텍스트 렌더) — 깨진 카드보다 원형 유지가 안전.
 */

export interface HitlRequest {
  toolName: string;
  inputSummary: string;
  timeoutSec: number;
}

const HITL_REQUEST_RE =
  /^🔒 승인 요청: `([^`]+)`\n입력: ([\s\S]*?)\n\n「allow」 또는 「deny <사유>」로 답해주세요 \((\d+)초 내 무응답 시 자동 거부\)\.$/;

/** content가 플러그인 HITL 승인요청 고정 포맷과 정확히 일치할 때만 파싱 결과를 반환. */
export function parseHitlRequest(content: string | null | undefined): HitlRequest | null {
  if (!content) return null;
  const m = HITL_REQUEST_RE.exec(content);
  if (!m) return null;
  const timeoutSec = Number(m[3]);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) return null;
  return { toolName: m[1]!, inputSummary: m[2]!, timeoutSec };
}

/** 플러그인 파싱 규약과 왕복되는 응답 문자열 생성(server.ts:466 regex와 대칭). */
export function formatHitlReply(decision: 'allow' | 'deny', reason?: string): string {
  const trimmed = reason?.trim();
  return decision === 'deny' && trimmed ? `deny ${trimmed}` : decision;
}

/** 같은 규약(server.ts:466)으로 human 메시지가 이 요청에 대한 allow/deny 답인지 판별. */
export function isHitlReply(content: string | null | undefined): { decision: 'allow' | 'deny'; reason?: string } | null {
  if (!content) return null;
  const m = /^\s*(allow|deny)\b\s*(.*)$/i.exec(content);
  if (!m) return null;
  const decision = m[1]!.toLowerCase() === 'allow' ? 'allow' : 'deny';
  const reason = m[2]?.trim();
  return reason ? { decision, reason } : { decision };
}

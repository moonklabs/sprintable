/**
 * story #4324 — 문서 콘텐츠에서 온 주소를 링크(href) · 틀(src)로 쓰기 전 거르는 한 곳. 렌더러(`doc-content-renderer.tsx`)와
 * 편집기 노드(`extensions/embed-node.tsx` · `extensions/file-node.tsx`)가 같은 도우미를 쓴다(사본 0 — 까디르 QA).
 *
 * 브라우저는 URL을 해석할 때 탭 · 개행을 어디서든 지우고 앞뒤 C0 제어 문자 · 공백을 걷는다(WHATWG URL). 그래서 검사도 **먼저
 * 같은 방식으로 정규화한 값**을 보고, 그 정규화한 값을 그대로 돌려준다 — 검사한 문자열과 실제 href가 어긋날 틈을 없앤다.
 */

/** 탭 · 개행 · 캐리지 리턴(어디서든) + 그 밖 C0 제어 문자 · DEL(어디서든) — 스킴 안에 끼워 넣는 우회(`java\tscript:` · `data:text/\thtml`)를 먼저 걷는다. */
const URL_INVISIBLES = /[\u0000-\u001F\u007F]/g;

function normalize(raw: string): string {
  return raw.replace(URL_INVISIBLES, '').trim();
}

/** http/https 절대 주소만(정규화한 href) · 그 밖(javascript: · vbscript: · data: · blob: · 상대 · `//` 스킴 없는 주소 등)은 null. */
export function safeHttpUrl(raw: string): string | null {
  const value = normalize(raw);
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * 옛 첨부 본문(base64 `data:` URL)으로 **허용하는 MIME만**(허용 목록 — 까디르 QA · PO 22:14Z). 문서로 열리거나 스크립트를 품을 수 있는
 * 종류(text/html · xhtml · svg · xml · javascript 등)와 목록 밖 전부는 거절 — 거부 목록은 새 변종(대소문자 · 파라미터 · 공백)에 늘 뒤진다.
 */
export const ATTACHMENT_DATA_MIME_ALLOWLIST: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

/** `data:<mime>[;params],<payload>`에서 mime이 허용 목록에 있을 때만 정규화한 값을 돌려준다(없거나 빈 mime · 목록 밖 · data: 아님 → null). */
export function safeAttachmentDataUrl(raw: string): string | null {
  const value = normalize(raw);
  const m = /^data:([^,]*),/i.exec(value);
  if (!m) return null;
  const mime = m[1]!.split(';')[0]!.trim().toLowerCase();
  return ATTACHMENT_DATA_MIME_ALLOWLIST.has(mime) ? value : null;
}

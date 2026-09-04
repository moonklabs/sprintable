/**
 * E-STORAGE S5 — Storage UI 표시 포매팅 헬퍼.
 * 파일 크기 포맷은 재구현 금지 → `formatFileSize`(file-node.tsx) 재사용. 여기엔 그 외 표시 유틸만.
 */

import { AGENT_MARK_FILL_CLASS } from '@/components/ui/agent-identity';
import type { AssetSourceLink } from '@/lib/storage/types';
import { formatScheduledAt } from '@/components/content/schedule-format';

/** 파일 아이콘 틴트 분류 — 목업 `.fic.*` 5종에 1:1 대응. */
export type FileTint = 'img' | 'pdf' | 'doc' | 'zip' | 'code';

/** 목업 토큰 매핑(oklch → canonical Tailwind 토큰 유틸리티). */
export const FILE_TINT_CLASS: Record<FileTint, string> = {
  img: 'bg-info/15 text-info',
  pdf: 'bg-destructive-tint text-destructive',
  doc: 'bg-success/15 text-success',
  // story #2590(TIER1 아이콘) — text-warning은 tint 유무와 무관하게 3.0 미달(실측, #2420 doc).
  // 형제(img/pdf/doc)는 자기 계열색이 통과라 그대로 두고 zip만 foreground로 잠정 통일.
  zip: 'bg-warning/15 text-foreground',
  code: 'bg-muted text-muted-foreground',
};

export function fileTypeTint(contentType: string): FileTint {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.startsWith('image/')) return 'img';
  if (ct === 'application/pdf') return 'pdf';
  if (
    ct.includes('zip') ||
    ct.includes('compressed') ||
    ct.includes('tar') ||
    ct.includes('gzip') ||
    ct.includes('x-7z')
  ) {
    return 'zip';
  }
  if (
    ct.includes('json') ||
    ct.includes('javascript') ||
    ct.includes('typescript') ||
    ct.includes('xml') ||
    ct.includes('html') ||
    ct.includes('css') ||
    ct.includes('yaml')
  ) {
    return 'code';
  }
  return 'doc';
}

/**
 * story #2921 S4 후속(유나 design:changes, 2026-08-22) — 이니셜 배경 무채 계승 처방. 옛
 * AVATAR_BG는 이름 해시로 시맨틱 신호색(info/success/warning/brand/destructive) 5색 중
 * 하나를 «무작위»로 골랐다 — 해시가 destructive를 뽑은 사람은 아바타가 «빨강=위반»으로
 * 읽히는 의미 충돌이었고(90% 무채 원칙도 파괴), 옛 ProofAvatar(agent=blue-soft·human=sunk
 * 무채 2값)에서의 회귀이기도 했다. 그 2값 체계를 그대로 계승 — 사람별 해시 다양성은
 * 포기하고(신호색 오염 제거가 우선), bg+text를 한 쌍으로 반환해 호출부가 text-white를
 * 별도로 하드코딩하지 않게 한다(밝은 -soft 배경 위 흰 글자 가독성 문제 원천 차단).
 */
export function avatarColor(isAgent: boolean): string {
  // story #3049(2984-S1) — agent 이니셜 배경은 AGENT_MARK_FILL_CLASS(투명·§2 형태로 이미
  // 있는 ring/border가 경계를 짊어짐). human 배경(무채 sunk)은 재질 이전 대상 밖(신호 없는
  // 중립 배경이라 SHIFT 항목이 아님) — 무변경.
  return isAgent ? AGENT_MARK_FILL_CLASS : 'bg-proof-sunk text-proof-ink-2';
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  const isLatin = /[a-zA-Z]/.test(first);
  if (parts.length === 1) {
    return isLatin ? first.slice(0, 2).toUpperCase() : first.slice(0, 1);
  }
  // story #2986(선생님 실사용 발견) — 어절별 첫 글자를 조합하면(라틴 이니셜 관례) 한글에서
  // 우연히 실제 단어(간혹 비속어)가 조립될 구조적 위험이 있다 — 「시스템 발행」→「시」+「발」
  // =「시발」실사고. 한글(및 그 외 비라틴) 다어절 이름은 조합하지 않고 첫 어절 첫 글자
  // 1자만 쓴다(단일 어절일 때와 동일 규칙). 라틴 다어절(예: John Smith)은 국제 관례대로
  // 각 단어 첫 글자 조합(JS)을 유지 — 위험은 한글류 음절 문자에 한정된다.
  if (isLatin) {
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
  }
  return first.slice(0, 1);
}

/** 파일 확장자 라벨 — 파일명 우선, 없으면 content-type subtype. (예: PNG·PDF·DOCX·JSON) */
export function fileExtLabel(contentType: string, name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toUpperCase();
  const sub = (contentType ?? '').split('/')[1] ?? '';
  return (sub.split('+')[0] || contentType || '').toUpperCase();
}

/**
 * 상대 시간 — story 3436(묶음 8) 정본. `Intl.RelativeTimeFormat`(선례:
 * team-activity-view.tsx `relativeTime`)로 로케일 하드코딩을 없앤다. notification-bell
 * `timeAgo`(구 비-export 중복)를 이 함수로 흡수·통합.
 *
 * 7일 초과는 "최신성"이 아니라 "그 시각이 정확히 언제였나"로 질문이 바뀐다 — §11-2 정본
 * (`formatScheduledAt`, displayTimezone 기준)으로 폴백한다(구현: UTC 슬라이스, tz 무시).
 */
export function formatRelativeTime(iso: string, locale: string, displayTimezone: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diffMs = Date.now() - t;
  if (diffMs >= 7 * 86400000) return formatScheduledAt(iso, displayTimezone).display;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const sec = Math.round(diffMs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  if (Math.abs(sec) < 60) return rtf.format(-sec, 'second');
  if (Math.abs(min) < 60) return rtf.format(-min, 'minute');
  if (Math.abs(hr) < 24) return rtf.format(-hr, 'hour');
  return rtf.format(-day, 'day');
}

/** 합계 크기(요약 칩) — formatFileSize 는 MB 상한이라 GB 까지 커버하는 별도 포맷터. */
export function formatTotalSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * 스토리지 용량 포맷(S8 용량 경고 배너) — formatTotalSize 는 GB 상한이라 TB 한도(엔터프라이즈
 * 플랜)에서 "5120.0 GB" 같이 깨진다. B/KB/MB/GB/TB 까지 커버하는 용량 전용 포맷터.
 * 예: 5368709120 → "5.0 GB", 0 → "0 B".
 */
export function formatStorageSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  if (gb < 1024) return `${gb.toFixed(1)} GB`;
  return `${(gb / 1024).toFixed(1)} TB`;
}

/** ISO → YYYY-MM-DD (상세 메타 '생성' 행). */
export function formatDate(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * BE-제공 string deeplink 안전화 — **내부 절대경로만** 허용.
 * `javascript:`·외부 URL·프로토콜-상대(`//host`)·제어문자 href 를 거부해 source title 클릭 XSS/오픈리다이렉트 차단.
 */
function safeInternalPath(path: string): string | null {
  if (typeof path !== 'string' || path.length === 0) return null;
  // '/' 로 시작하되 '//'(프로토콜-상대) 아님 → 내부 경로
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  // 제어문자(개행/탭 등) 포함 시 거부
  if (/[\u0000-\u001f]/.test(path)) return null;
  return path;
}

/**
 * 딥링크 resolve — BE 계약상 type별 형상이 달라(string·객체) 단일 href 로 정규화.
 * null 반환 시 UI는 평문(arrow 제거). manual 은 항상 null.
 * 보안: string 은 safeInternalPath 통과분만, 객체 동적 세그먼트는 encodeURIComponent.
 * 객체 형상 → 레포 라우팅 관례 재사용:
 *   - conversation: `/chats/{conversation_id}` (+ message 강조 `?messageId=`; 전용 관례 부재→가정)
 *   - doc: `/docs/{doc_slug}`
 *   - story: `/board?story={story_id}` (notification-bell 관례 재사용)
 */
export function resolveDeeplinkHref(link: AssetSourceLink): string | null {
  const d = link.deeplink;
  if (d == null) return null;
  if (typeof d === 'string') return safeInternalPath(d);
  if ('conversation_id' in d && d.conversation_id) {
    const base = `/chats/${encodeURIComponent(d.conversation_id)}`;
    const messageId = 'message_id' in d ? d.message_id : undefined;
    return messageId ? `${base}?messageId=${encodeURIComponent(messageId)}` : base;
  }
  if ('doc_slug' in d && d.doc_slug) return `/docs/${encodeURIComponent(d.doc_slug)}`;
  if ('story_id' in d && d.story_id) return `/board?story=${encodeURIComponent(d.story_id)}`;
  return null;
}

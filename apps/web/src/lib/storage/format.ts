/**
 * E-STORAGE S5 — Storage UI 표시 포매팅 헬퍼.
 * 파일 크기 포맷은 재구현 금지 → `formatFileSize`(file-node.tsx) 재사용. 여기엔 그 외 표시 유틸만.
 */

import type { AssetSourceLink } from '@/lib/storage/types';

/** 파일 아이콘 틴트 분류 — 목업 `.fic.*` 5종에 1:1 대응. */
export type FileTint = 'img' | 'pdf' | 'doc' | 'zip' | 'code';

/** 목업 토큰 매핑(oklch → canonical Tailwind 토큰 유틸리티). */
export const FILE_TINT_CLASS: Record<FileTint, string> = {
  img: 'bg-info/15 text-info',
  pdf: 'bg-destructive/10 text-destructive',
  doc: 'bg-success/15 text-success',
  zip: 'bg-warning/15 text-warning',
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

/** 결정론적 아바타 배경(고정 토큰 유틸 집합 — Tailwind safelist 안전). */
const AVATAR_BG = ['bg-info', 'bg-success', 'bg-warning', 'bg-brand', 'bg-destructive'] as const;

export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_BG[hash % AVATAR_BG.length] ?? AVATAR_BG[0];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) {
    const p = parts[0] ?? '';
    return /[a-zA-Z]/.test(p) ? p.slice(0, 2).toUpperCase() : p.slice(0, 1);
  }
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** 파일 확장자 라벨 — 파일명 우선, 없으면 content-type subtype. (예: PNG·PDF·DOCX·JSON) */
export function fileExtLabel(contentType: string, name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toUpperCase();
  const sub = (contentType ?? '').split('/')[1] ?? '';
  return (sub.split('+')[0] || contentType || '').toUpperCase();
}

/**
 * KO 상대 시간 — 레포에 export 된 공용 유틸이 없어(notification-bell `timeAgo`는 비-export)
 * 동일 규칙으로 구현. 방금/N분 전/N시간 전/어제/N일 전/날짜.
 */
export function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '어제';
  if (days < 7) return `${days}일 전`;
  return new Date(iso).toISOString().slice(0, 10);
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
  // eslint-disable-next-line no-control-regex
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

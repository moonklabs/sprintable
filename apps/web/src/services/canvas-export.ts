/**
 * E-CANVAS C1-S5 — export FE. BE(`visual_artifacts.py` export 엔드포인트, `95cf5d32`)를
 * 직접 읽고 확인: PNG는 클라 캡처(FE가 이미 라이브 렌더 중인 DOM을 html2canvas로 캡처) →
 * signed write URL 3-step(upload-url → PUT 직접 업로드 → complete), HTML은 BE가 nodes를
 * 즉시 직렬화(단일 POST, 렌더 불요). **테마/뷰포트는 BE 계약에 없다** — PNG 캡처 전 클라이언트가
 * DOM에 순간 적용하는 캡처 조건일 뿐, 서버에 전달하는 파라미터가 아니다.
 */

import type { ArtifactFormat } from './canvas';

export type ExportFormat = 'png' | 'html';

/** BE `ExportUploadUrlResponse` 미러. */
export interface BeExportUploadUrlResponse {
  upload_url: string;
  object_path: string;
  expires_at: string;
}

/** BE `ArtifactExportResponse` 미러. */
export interface BeArtifactExport {
  id: string;
  artifact_id: string;
  version_id: string;
  version_number: number;
  format: string;
  created_by: string | null;
  created_at: string;
  /** 유나 UX 결정③(공유 링크 1급) — 안정적 공유 참조. */
  asset_id: string;
  download_url: string | null;
}

function unwrap<T>(json: unknown): T | null {
  if (!json || typeof json !== 'object') return null;
  const d = (json as { data?: unknown }).data;
  return (d ?? json) as T;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return unwrap<T>(await res.json());
  } catch {
    return null;
  }
}

/** 1단계 — signed write URL 발급. */
export function requestPngUploadUrl(artifactId: string, versionNumber: number, contentType = 'image/png') {
  return fetchJson<BeExportUploadUrlResponse>(
    `/api/visual-artifacts/${artifactId}/versions/${versionNumber}/export/png/upload-url`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content_type: contentType }) },
  );
}

/**
 * 2단계 — signed URL로 직접 PUT(우리 프록시 경유 아님, BE가 서명한 스토리지 URL 그대로).
 * D3 "put=FE 원칙" — 바이너리가 우리 서버를 거치지 않는다.
 */
export async function uploadToSignedUrl(uploadUrl: string, blob: Blob, contentType: string): Promise<boolean> {
  try {
    const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: blob });
    return res.ok;
  } catch {
    return false;
  }
}

/** 3단계 — 업로드 완료 통지(BE가 head_object로 실체 검증 후 asset 편입). */
export function completePngExport(artifactId: string, versionNumber: number, objectPath: string) {
  return fetchJson<BeArtifactExport>(
    `/api/visual-artifacts/${artifactId}/versions/${versionNumber}/export/png/complete`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ object_path: objectPath }) },
  );
}

/** HTML export — 단일 호출(BE가 nodes를 as-authored 그대로 직렬화, 렌더/캡처 불요). */
export function createHtmlExport(artifactId: string, versionNumber: number) {
  return fetchJson<BeArtifactExport>(
    `/api/visual-artifacts/${artifactId}/versions/${versionNumber}/export/html`,
    { method: 'POST' },
  );
}

export function listArtifactExports(artifactId: string, versionNumber?: number) {
  const qs = versionNumber != null ? `?version_number=${versionNumber}` : '';
  return fetchJson<BeArtifactExport[]>(`/api/visual-artifacts/${artifactId}/exports${qs}`);
}

/**
 * html2canvas로 DOM 캡처 → PNG blob. 캡처 대상은 호출부가 ref로 넘긴다(뷰포트/테마는 캡처
 * 직전 호출부가 DOM에 순간 적용해두는 클라이언트 전용 조건 — BE는 결과 PNG만 받는다).
 *
 * ⚠️ format='html' artifact는 캡처 불가 — `ArtifactStage`가 html을 `sandbox=""`(allow-same-origin
 * 없음, 보안 원칙 유지) iframe으로 렌더하는데, 이 플래그가 iframe에 부모 문서와 다른 opaque
 * origin을 주어 html2canvas(부모 문서 JS 컨텍스트에서 실행)가 안을 못 읽는다 — cross-origin
 * 격리가 캡처도 막는다(보안과 export 사이 실 트레이드오프, sandbox 완화는 선택지에서 제외).
 * 그래서 PNG export는 tree/image 포맷에서만 제공(canPngExport() 참고), html은 HTML export로.
 */
export function canPngExport(format: ArtifactFormat): boolean {
  return format !== 'html';
}

export async function captureElementAsPng(el: HTMLElement): Promise<Blob | null> {
  const { default: html2canvas } = await import('html2canvas');
  // 유나 §③ "2x retina·흐릿=신뢰 깎임" — scale 미지정 시 1x라 export 첫인상이 흐릿해진다.
  const canvas = await html2canvas(el, { backgroundColor: null, useCORS: true, scale: 2 });
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

/**
 * PNG 캡처 직전 뷰포트/테마를 DOM에 순간 적용 — 복원 함수를 반환(호출부가 try/finally로
 * 반드시 되돌린다). BE 계약엔 없는 순수 클라 조건(위 파일 헤더 참고).
 */
export function applyCaptureConditions(
  el: HTMLElement, viewport: 'desktop' | 'mobile', theme: 'light' | 'dark',
): () => void {
  const prevWidth = el.style.width;
  const hadDark = el.classList.contains('dark');
  if (viewport === 'mobile') el.style.width = '390px';
  if (theme === 'dark') el.classList.add('dark'); else el.classList.remove('dark');
  return () => {
    el.style.width = prevWidth;
    if (hadDark) el.classList.add('dark'); else el.classList.remove('dark');
  };
}

/** 3-step 전체 오케스트레이션 — 캡처→upload-url→PUT→complete. 실패 지점을 그대로 반환. */
export async function exportPng(artifactId: string, versionNumber: number, el: HTMLElement): Promise<BeArtifactExport | null> {
  const blob = await captureElementAsPng(el);
  if (!blob) return null;
  const uploadInfo = await requestPngUploadUrl(artifactId, versionNumber);
  if (!uploadInfo) return null;
  const uploaded = await uploadToSignedUrl(uploadInfo.upload_url, blob, 'image/png');
  if (!uploaded) return null;
  return completePngExport(artifactId, versionNumber, uploadInfo.object_path);
}

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
  // html2canvas-pro(드롭인 fork) — 원본 html2canvas@1.4.1은 oklch()/color-mix(in oklch,…)를
  // "unsupported color function"으로 throw했다(우리 디자인 토큰 globals.css 145곳). pro는 modern
  // CSS 색 함수(oklch·color-mix·lab·lch)를 네이티브 파싱해 캡처가 throw 없이 성공한다.
  const { default: html2canvas } = await import('html2canvas-pro');
  // 유나 §③ "2x retina·흐릿=신뢰 깎임" — scale 미지정 시 1x라 export 첫인상이 흐릿해진다.
  const canvas = await html2canvas(el, { backgroundColor: null, useCORS: true, scale: 2 });
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

/**
 * PNG 캡처 직전 테마를 DOM에 순간 적용 — 복원 함수를 반환(호출부가 try/finally로 반드시
 * 되돌린다). BE 계약엔 없는 순수 클라 조건(위 파일 헤더 참고).
 *
 * story d72db00a 그라운딩 발견(발견 즉시 수정 — 별도 방치 안 함): 원래 여기 있던 `viewport`
 * (desktop/mobile 폭 시뮬레이션) 파라미터는 story 1948d19d(canvas_bounds 고정 아트보드
 * 도입) 이후로 이미 무효였다 — html iframe/tree 콘텐츠가 `bounds.w/h` 인라인 style로
 * 고정 렌더되어 조상 요소의 width를 바꿔도 반응하지 않는다. 게다가 캡처 대상이 이제
 * 콘텐츠 레이어 자체(`contentRef`)라 el.style.width를 덮어쓰면 "아트보드 전체 프레임"
 * 계약(AC1)과 직접 충돌한다. 아무 효과 없는 토글을 남겨두는 게 더 위험한 기만이라 UI·
 * 타입·이 함수 인자에서 전부 제거했다(뷰포트 시뮬레이션 자체의 재설계는 이 스토리 범위 밖).
 */
export function applyCaptureConditions(el: HTMLElement, theme: 'light' | 'dark'): () => void {
  const hadDark = el.classList.contains('dark');
  if (theme === 'dark') el.classList.add('dark'); else el.classList.remove('dark');
  return () => {
    if (hadDark) el.classList.add('dark'); else el.classList.remove('dark');
  };
}

/**
 * story d72db00a AC1~2 — PNG export=아트보드 전체 프레임(canvas_bounds 기준)을 100% 스케일로,
 * 뷰포트 pan/zoom 상태와 무관하게. 캡처 대상(`data-artifact-canvas-content`)은 항상
 * CanvasViewport의 현재 pan/zoom `transform: translate(tx,ty) scale(s)`를 인라인 style로
 * 갖고 있다 — 캡처 직전 이걸 identity로 순간 고정하고 복원한다. width/height는 이미
 * `bounds.w/h`로 고정돼 있어 건드릴 필요 없다(포맷별로 canvas_bounds 또는 image 실측
 * 크기가 이미 반영됨). 사용자 선택 옵션이 아니라 구조적 요구사항이라 테마 토글과 분리.
 */
export function neutralizeCaptureTransform(el: HTMLElement): () => void {
  const prevTransform = el.style.transform;
  el.style.transform = 'translate(0px, 0px) scale(1)';
  return () => { el.style.transform = prevTransform; };
}

/** 3-step 전체 오케스트레이션 — 캡처→upload-url→PUT→complete. 실패 지점을 그대로 반환. */
export async function exportPng(artifactId: string, versionNumber: number, el: HTMLElement): Promise<BeArtifactExport | null> {
  const restoreTransform = neutralizeCaptureTransform(el);
  let blob: Blob | null;
  try {
    blob = await captureElementAsPng(el);
  } finally {
    restoreTransform();
  }
  if (!blob) return null;
  const uploadInfo = await requestPngUploadUrl(artifactId, versionNumber);
  if (!uploadInfo) return null;
  const uploaded = await uploadToSignedUrl(uploadInfo.upload_url, blob, 'image/png');
  if (!uploaded) return null;
  return completePngExport(artifactId, versionNumber, uploadInfo.object_path);
}

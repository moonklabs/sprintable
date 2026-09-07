import { fetchWithAuth } from '@/lib/db/client';
import { HUMAN_SAFE_ERROR_MESSAGE_CODES } from '@/lib/api-error-message';

/** story #2887(S2g) — BE avatar 3단 계약(team_members.py) 클라 소비. png/jpeg/webp만
 * 서버가 서명 발급 단계에서 검증하지만, 클라도 동일 화이트리스트로 조기 거절(UX — 업로드
 * 시도 전에 알려준다). */
export const AVATAR_ALLOWED_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export interface AvatarUploadUrlResponse {
  upload_url: string;
  object_path: string;
  public_url: string;
  expires_at: string;
  max_bytes: number;
}

export interface AvatarApiError {
  code: string;
  message: string;
}

async function readError(res: Response): Promise<AvatarApiError> {
  try {
    // story #3601(디디 전수 표 2026-09-07) — BE 전역 봉투는 {data,error,meta}뿐이라
    // json.data는 에러 응답에서 항상 null·json.detail은 항상 undefined였다 — 실
    // 에러(json.error)를 한 번도 안 읽고 매번 "HTTP {status}" 제네릭으로 떨어졌다.
    // 페드루 PO 정정(2026-09-07, 유나 Design CHANGES) — AvatarUploadError의 실제
    // message는 사람 문장이 아니다(예: UNSUPPORTED_CONTENT_TYPE이 원문 content_type
    // 값+허용 목록 repr을 그대로 담는다, avatar_upload.py:72) — code는 살리고 message
    // 만 공용 allowlist(HUMAN_SAFE_ERROR_MESSAGE_CODES)로 gate한다. 지금 avatar 쪽
    // 코드는 전부 이 목록 밖이라 message는 항상 제네릭으로 떨어진다(안전한 기본값 —
    // 사람 문장으로 확認된 avatar 코드가 생기면 그때 등재).
    const json = await res.json() as { data?: AvatarApiError; error?: AvatarApiError; detail?: AvatarApiError };
    const raw = json.error ?? json.data ?? json.detail ?? { code: 'UNKNOWN', message: `HTTP ${res.status}` };
    if (!HUMAN_SAFE_ERROR_MESSAGE_CODES.has(raw.code)) {
      return { code: raw.code, message: `HTTP ${res.status}` };
    }
    return raw;
  } catch {
    return { code: 'UNKNOWN', message: `HTTP ${res.status}` };
  }
}

async function requestUploadUrl(memberId: string, contentType: string): Promise<AvatarUploadUrlResponse> {
  const res = await fetchWithAuth(`/api/team-members/${memberId}/avatar/upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: contentType }),
  });
  if (!res.ok) throw await readError(res);
  const json = await res.json() as { data: AvatarUploadUrlResponse };
  return json.data;
}

/** 서명 PUT URL은 GCS 직결 — fetchWithAuth(Authorization 헤더) 안 태운다. XHR로 진행률 추적. */
function putToSignedUrl(uploadUrl: string, file: Blob, contentType: string, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject({ code: 'PUT_FAILED', message: `업로드 실패(HTTP ${xhr.status})` } satisfies AvatarApiError);
    };
    xhr.onerror = () => reject({ code: 'PUT_FAILED', message: '업로드 네트워크 오류' } satisfies AvatarApiError);
    xhr.send(file);
  });
}

interface ConfirmedMember { avatar_url: string | null; [key: string]: unknown }

async function confirmUpload(memberId: string, objectPath: string): Promise<ConfirmedMember> {
  const res = await fetchWithAuth(`/api/team-members/${memberId}/avatar/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object_path: objectPath }),
  });
  if (!res.ok) throw await readError(res);
  const json = await res.json() as { data: ConfirmedMember };
  return json.data;
}

/** 3단 전체(발급→PUT→confirm) — story #2887 BE 계약 그대로. 반환값 = confirm이 준 갱신된
 * avatar_url(새 키). */
export async function uploadAvatar(
  memberId: string,
  file: Blob,
  contentType: string,
  onProgress?: (pct: number) => void,
): Promise<string | null> {
  const { upload_url, object_path } = await requestUploadUrl(memberId, contentType);
  await putToSignedUrl(upload_url, file, contentType, onProgress);
  const updated = await confirmUpload(memberId, object_path);
  return updated.avatar_url;
}

export async function removeAvatar(memberId: string): Promise<void> {
  const res = await fetchWithAuth(`/api/team-members/${memberId}/avatar`, { method: 'DELETE' });
  if (!res.ok) throw await readError(res);
}

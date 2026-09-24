'use client';

// story #4266(유나 · PO) — 발행 «다시 시도» 확인 창의 공용 결과 처리. 세 자리(채널 포스트 상세 · 사이트 글 상세 · 게이트 뉴스레터 발송)가
// 같은 규칙을 쓴다:
// - 결과가 무엇이든 확인 창은 닫고, 결과 줄을 화면에 보인다(예전엔 실패면 창이 열린 채 남고 오류 줄이 오버레이 뒤에 그려졌다 · 사이트 글은
//   결과 줄 자체가 없었다).
// - 404(누가 먼저 다시 시도했거나 상태가 이미 바뀜)는 서버 원문(«command를 찾을 수 없거나 재시도 대상이 아닙니다») 대신 상태를 다시 읽고
//   유나 확정 문장을 보인다 — 다시 읽기는 호출처의 reload(성공과 같은 함수).
// - 그 밖의 실패는 서버 원문 대신 알려진 코드의 로케일 문장(403 사람 전용 등 기존 매핑) · 모르면 «다시 시도하지 못했어요.». 서버 응답은
//   접힌 «서버 응답 보기»에만(기존 RawDetailsToggle 관례).
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { parseSitePostApiError } from '@/components/content/api-error';
import { RawDetailsToggle } from '@/components/content/raw-details-toggle';
import { fetchWithAuth } from '@/lib/db/client';

export type PublicationRetryResult =
  | { type: 'success' }
  | { type: 'not_retryable' }
  /** messageKey 없음 = 모르는 실패 · 네트워크 → «다시 시도하지 못했어요.»(렌더 자리에서 t 리터럴 — 죽은 키 가드가 읽는 형태). */
  | { type: 'error'; messageKey?: string; raw?: string };

/** 재시도 POST 한 번 → 결과 분류. 네트워크 실패도 error(throw 안 함). */
export async function postPublicationRetry(url: string): Promise<PublicationRetryResult> {
  try {
    const res = await fetchWithAuth(url, { method: 'POST' });
    if (res.ok) return { type: 'success' };
    if (res.status === 404) return { type: 'not_retryable' };
    const info = parseSitePostApiError(await res.json().catch(() => null));
    return { type: 'error', messageKey: info.humanMessageKey, raw: info.raw };
  } catch {
    return { type: 'error' };
  }
}

/** 확인 창 밖(창을 닫은 뒤) 화면에 남는 결과 줄. */
export function PublicationRetryResultLine({ result, testId }: { result: PublicationRetryResult | null; testId: string }) {
  const t = useTranslations('content');
  if (!result) return null;
  const isError = result.type === 'error';
  const text = result.type === 'success' ? t('channelPostsRetrySuccess')
    : result.type === 'not_retryable' ? t('publicationRetryNotRetryableReloaded')
    : result.messageKey ? t(result.messageKey) : t('channelPostsRetryFailed');
  return (
    <Alert variant={isError ? 'destructive' : 'default'} role={isError ? 'alert' : 'status'} data-testid={testId}>
      <AlertDescription className="break-keep">{text}</AlertDescription>
      {isError ? <RawDetailsToggle raw={result.raw} label={t('errorRawDetailsToggle')} /> : null}
    </Alert>
  );
}

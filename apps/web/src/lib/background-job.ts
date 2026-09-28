// story #4336 PR2(PO 04:32Z) — 요청 한도를 넘을 수 있는 일(영상 확정 등)은 백엔드가 202 + 작업(id · 상태)을 돌려주고 cron 워커(1분 틱)가
// 이어서 한다. 화면은 작업 상태 보기로 끝(completed · failed)까지 다시 묻는다 — 간격은 발행 워커 폴링과 같은 값(한 곳).
import { fetchWithAuth } from '@/lib/db/client';
import { LONG_ROUTES } from '@/lib/bff-route-timeouts';
// 발행 워커 폴링(채널 초안 상세)과 같은 5초. PR 4767이 그 값을 `lib/publish-worker-poll.ts` 한 곳으로 모으는 중 — 병합 뒤 그 상수로 합친다.
export const BACKGROUND_JOB_POLL_MS = 5000;
/** PO 결정(05:22Z · 유나 권고) — 작업을 이만큼 넘게 기다리면 같은 진행 줄에 «시간이 걸리고 있어요 — 창을 닫아도 계속 처리돼요». 워커가 끝까지
 * 처리하고 다음 방문 때 결과가 보이니 참인 문장. */
export const SLOW_JOB_NOTICE_MS = 10_000;

export type BackgroundJobStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface BackgroundJob<R = Record<string, unknown>> {
  id: string;
  kind: string;
  status: BackgroundJobStatus;
  result: R | null;
  /** 실패면 요청이 그대로 받았을 본문 — `{ status_code, detail: { code, message, … } }`. */
  error: { status_code: number; detail: unknown } | null;
}

export function isFinishedJob(job: Pick<BackgroundJob, 'status'>): boolean {
  return job.status === 'completed' || job.status === 'failed';
}

/** 작업이 끝날 때까지 다시 묻는다. `signal`이 끊기면(화면을 떠남) 멈추고 null. 응답을 못 받은 한 번은 건너뛰고 계속 묻는다. */
export async function waitForBackgroundJob<R>(
  orgId: string, jobId: string, { signal, intervalMs = BACKGROUND_JOB_POLL_MS }: { signal?: AbortSignal; intervalMs?: number } = {},
): Promise<BackgroundJob<R> | null> {
  for (;;) {
    if (signal?.aborted) return null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    if (signal?.aborted) return null;
    const res = await fetchWithAuth(`/api/organizations/${orgId}/background-jobs/${jobId}`, {
      timeoutMs: LONG_ROUTES.backgroundJobStatus.browserMs,
    }).catch(() => null);
    if (!res?.ok) continue;
    const json = (await res.json().catch(() => null)) as { data?: BackgroundJob<R> } | null;
    const job = json?.data;
    if (job && isFinishedJob(job)) return job;
  }
}

import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-MODERN CC-FE: 커맨드 센터 ② 프로젝트 현황 + 헤더 함대 프록시. raw passthrough(Bot-L.2 #1673 동형).
// ⛔story #2338(2026-07-30) 정정 — 아래 줄은 CC-BE.2 착수 당시("BE가 아직 안 보낸다") 적힌
// 주석인데, BE가 그 뒤 실 객체를 보내기 시작한 뒤로 한 번도 안 고쳐졌다(그게 이 프록시가
// «죽은 주석»이 된 근본 원인 — 계약이 바뀌었는데 소비자 쪽 문서가 안 따라간 것). 지금 실제
// shape: fleet.total_agents·epics·outcome·recent_changes·status_breakdown·risk·cycle_time·
// contribution·cost_trend 전부 실 객체. risk.overdue «필드 하나»만 BE가 여전히 리터럴
// {status:"pending_data"}를 심어 보낸다(command_center.py 실측, 진짜 미구현). raw
// passthrough라 이 프록시 자체는 고칠 게 없다 — shape 진실은 apps/web .../types.ts 주석 참고.

/** GET /api/dashboard/overview → /api/v2/command-center/overview */
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, '/api/v2/command-center/overview');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}

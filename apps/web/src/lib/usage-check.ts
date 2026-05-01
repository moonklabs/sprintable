
// OSS stub — 실제 구현은 @moonklabs/sprintable-saas 에 있다.
// OSS 단독 빌드에서는 usage 한도가 없으므로 모든 호출이 allowed로 반환된다.

export interface UsageCheckResult {
  allowed: boolean;
  currentValue: number;
  limitValue: number | null;
  percentage: number;
  meterType: string;
}

export async function checkUsage(
  _db: any,
  _orgId: string,
  meterType: string,
): Promise<UsageCheckResult> {
  return { allowed: true, currentValue: 0, limitValue: null, percentage: 0, meterType };
}

export async function incrementUsage(
  _db: any,
  _orgId: string,
  _meterType: string,
  _delta: number = 1,
): Promise<void> {
  // no-op in OSS
}

export function getThresholdAlert(percentage: number): 'warning_80' | 'warning_90' | 'limit_reached' | null {
  if (percentage >= 100) return 'limit_reached';
  if (percentage >= 90) return 'warning_90';
  if (percentage >= 80) return 'warning_80';
  return null;
}

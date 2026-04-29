/**
 * EE enablement check — placeholder implementation.
 * S5에서 LICENSE_CONSENT 검증 로직으로 교체 예정.
 */
export function isEEEnabled(): boolean {
  return process.env.LICENSE_CONSENT === 'agreed';
}

/**
 * EE (Enterprise Edition) runtime gating.
 *
 * Activation: set LICENSE_CONSENT=agreed in the environment.
 * OSS builds that omit this variable get all EE features disabled.
 *
 * MVP: environment-variable only (no license server). A license server
 * validation layer can be layered on top later.
 *
 * Cal.com / Infisical 패턴 참조 — 서버 검증 없이 env 기반.
 */

const VALID_CONSENT = 'agreed';

/** Returns true when the EE feature set is activated. */
export function isEEEnabled(): boolean {
  const raw = process.env['LICENSE_CONSENT'];
  if (!raw) return false;
  return raw.trim().toLowerCase() === VALID_CONSENT;
}

/**
 * Throws an `EENotEnabledError` (HTTP 403) when EE is not active.
 * Use in server-side Route Handlers.
 */
export function assertEEEnabled(): void {
  if (!isEEEnabled()) throw new EENotEnabledError();
}

export class EENotEnabledError extends Error {
  readonly status = 403 as const;
  readonly code = 'EE_NOT_ENABLED' as const;

  constructor() {
    super(
      'Enterprise Edition features are not enabled. ' +
      'Set LICENSE_CONSENT=agreed to activate.',
    );
    this.name = 'EENotEnabledError';
  }
}

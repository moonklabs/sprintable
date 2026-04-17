import type { KmsProvider, KmsRotationResult } from './provider';
import { getKmsAdapter } from './provider';

export async function executeKmsRotation(
  orgId: string,
  kmsProvider?: KmsProvider | null,
): Promise<KmsRotationResult> {
  const adapter = getKmsAdapter(kmsProvider ?? undefined);
  return adapter.rotateOrgKey(orgId);
}

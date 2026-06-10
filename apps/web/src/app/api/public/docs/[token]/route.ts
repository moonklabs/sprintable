import { handleApiError } from '@/lib/api-error';
import { apiSuccess } from '@/lib/api-response';
import { createDocRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ token: string }> };

/**
 * Public, unauthenticated proxy — resolve a shared doc by opaque token (b1574f5a).
 * The BE returns the raw public payload on success; we wrap it in the `{ data }`
 * envelope the viewer reads. Invalid/revoked/expired tokens surface as 404/410
 * via handleApiError (the doc's existence is never disclosed).
 */
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { token } = await params;
    const repo = await createDocRepository();
    const doc = await repo.getPublicByToken(token);
    return apiSuccess(doc);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

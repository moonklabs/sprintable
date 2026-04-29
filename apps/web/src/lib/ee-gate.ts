import { NextResponse, type NextRequest } from 'next/server';
import { isEEEnabled } from './ee-enabled';

type RouteHandler<P = Record<string, string>> = (
  req: NextRequest,
  ctx: { params: P },
) => Promise<Response> | Response;

const EE_DISABLED_RESPONSE = NextResponse.json(
  { error: { code: 'EE_NOT_ENABLED', message: 'Enterprise Edition not enabled. Set LICENSE_CONSENT=agreed.' } },
  { status: 403 },
);

/**
 * Wraps a Next.js Route Handler with an EE license gate.
 * Returns HTTP 403 when LICENSE_CONSENT is not set to 'agreed'.
 */
export function withEEGate<P = Record<string, string>>(handler: RouteHandler<P>): RouteHandler<P> {
  return (req, ctx) => {
    if (!isEEEnabled()) return EE_DISABLED_RESPONSE;
    return handler(req, ctx);
  };
}

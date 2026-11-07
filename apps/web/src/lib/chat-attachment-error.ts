/**
 * story 4847 — a room with no project (it outlives its project since 4846 PR1) cannot take a NEW attachment: the server says so with 400 `ATTACHMENT_NEEDS_PROJECT`
 * (on the message send that registers the attachment) and the web's own upload route says the same before it puts a file in storage (it does not pass through the server).
 * The envelope is the one every coded refusal has: `{ data: null, error: { code, message }, meta: null }`. The web branches on the CODE only and speaks in its own words
 * (the server's `message` is not shown). 4846 PR2 (AC6) lifts the refusal; nothing here needs to change then — the code simply stops coming.
 */
export const ATTACHMENT_NEEDS_PROJECT = 'ATTACHMENT_NEEDS_PROJECT';

export class AttachmentNeedsProjectError extends Error {
  constructor() {
    super(ATTACHMENT_NEEDS_PROJECT);
    this.name = 'AttachmentNeedsProjectError';
  }
}

/** the `error.code` of a refusal body, or null (anything that is not that envelope) */
export function refusalCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** Read a failed response: throw the typed error for the one code the web speaks for, else the given plain error. */
export async function throwForFailedResponse(res: Response, plain: string): Promise<never> {
  const body = await res.json().catch(() => null);
  if (refusalCode(body) === ATTACHMENT_NEEDS_PROJECT) throw new AttachmentNeedsProjectError();
  throw new Error(plain);
}

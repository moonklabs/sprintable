import { createStoryRepository } from '@/lib/storage/factory';
import { verifyGitHubSignature, extractTicketIds } from '@/lib/github-webhook';
import type { GitHubPullRequestPayload } from '@/lib/github-webhook';

// Always return 200 to prevent GitHub retry storms (5xx triggers exponential backoff).
// Log errors server-side; never expose internals to GitHub.
export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const event = request.headers.get('x-github-event');
    const signature = request.headers.get('x-hub-signature-256');
    const secret = process.env['GITHUB_WEBHOOK_SECRET'];

    if (!secret) {
      console.warn('[github-webhook] GITHUB_WEBHOOK_SECRET not configured — rejecting');
      return new Response('Webhook secret not configured', { status: 400 });
    }

    const valid = await verifyGitHubSignature(secret, rawBody, signature);
    if (!valid) {
      console.warn('[github-webhook] Invalid signature');
      return new Response('Invalid signature', { status: 400 });
    }

    // Only handle PR merge events
    if (event !== 'pull_request') {
      return new Response('OK', { status: 200 });
    }

    const payload = JSON.parse(rawBody) as GitHubPullRequestPayload;

    if (payload.action !== 'closed' || !payload.pull_request.merged) {
      return new Response('OK', { status: 200 });
    }

    const ticketIds = extractTicketIds(
      payload.pull_request.title,
      payload.pull_request.body,
    );

    if (ticketIds.length === 0) {
      return new Response('OK', { status: 200 });
    }

    const repo = await createStoryRepository();

    for (const ticketId of ticketIds) {
      try {
        const stories = await repo.list({ q: ticketId, limit: 5 });
        const match = stories.find(
          (s) =>
            s.title.toUpperCase().includes(ticketId.toUpperCase()) &&
            s.status !== 'done',
        );
        if (match) {
          await repo.update(match.id, { status: 'done' });
          console.info(`[github-webhook] Closed story ${match.id} (${ticketId}) via PR #${payload.pull_request.number}`);
        }
      } catch (err) {
        console.error(`[github-webhook] Failed to close story for ${ticketId}:`, err);
        // Continue processing other ticket IDs
      }
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    // Never return 5xx — GitHub will retry and create duplicate updates
    console.error('[github-webhook] Unhandled error:', err);
    return new Response('OK', { status: 200 });
  }
}

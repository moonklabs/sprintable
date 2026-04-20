import { createHmac, timingSafeEqual } from 'crypto';

export interface GitHubPullRequestPayload {
  action: string;
  pull_request: {
    merged: boolean;
    title: string;
    body: string | null;
    number: number;
    html_url: string;
  };
  repository: {
    full_name: string;
  };
}

// Ticket ID patterns: "SPR-123", "closes SPR-123", "fixes #SPR-123", "closes #123"
const TICKET_PATTERNS = [
  /\bSPR-(\d+)\b/gi,
  /(?:closes?|fixes?|resolves?)\s+#(\d+)\b/gi,
];

export function extractTicketIds(title: string, body: string | null): string[] {
  const text = `${title} ${body ?? ''}`;
  const ids = new Set<string>();

  for (const pattern of TICKET_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      // Full match like "SPR-123" or just the number for "#123" patterns
      const full = match[0].match(/SPR-\d+/i)?.[0] ?? `SPR-${match[1]}`;
      ids.add(full.toUpperCase());
    }
  }

  return Array.from(ids);
}

export async function verifyGitHubSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
): Promise<boolean> {
  if (!signatureHeader?.startsWith('sha256=')) return false;

  const expected = Buffer.from(
    createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex'),
    'hex',
  );
  const received = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');

  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

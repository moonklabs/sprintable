import { readFileSync } from 'node:fs';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const UNKNOWN = 'unknown';
const SHA = /^[0-9a-f]{7,40}$/;
const REVISION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** A value only in its expected shape — anything else is reported as unknown, never echoed. */
function shaped(value: string | undefined, pattern: RegExp): string {
  const v = (value ?? '').trim();
  return pattern.test(v) ? v : UNKNOWN;
}

function readBuildTime(): string | undefined {
  try {
    return readFileSync(process.env.APP_BUILD_TIME_FILE ?? '/app/.build_time', 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * AC6: 헬스체크 엔드포인트.
 * story #4513 — what this instance runs: the commit (image build-arg) · the Cloud Run revision (K_REVISION) · the build time,
 * each «unknown» when absent. A deploy is confirmed serving by this read, not only by gcloud. No secret · no internal address.
 */
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '0.0.1',
    commit_sha: shaped(process.env.APP_COMMIT_SHA, SHA),
    revision: shaped(process.env.K_REVISION, REVISION),
    build_time: shaped(readBuildTime(), TIME),
  });
}

const LOCAL_APP_URL = 'http://localhost:3000';
const PRODUCTION_APP_URL = 'https://sprintable.vercel.app';

function normalizeUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/$/, '');
}

function normalizeHostAsUrl(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    return normalizeUrl(trimmed);
  }

  return normalizeUrl(`https://${trimmed}`);
}

export function resolveAppUrl(appUrl: string | null | undefined, env: NodeJS.ProcessEnv = process.env) {
  // 명시적으로 전달된 appUrl이 있으면 사용
  const explicit = normalizeUrl(appUrl) ?? normalizeUrl(env['NEXT_PUBLIC_APP_URL']);
  if (explicit) return explicit;

  // Vercel 환경 감지 - runtime에서 env var 미노출될 수 있으므로 여러 방식으로 체크
  const isVercel = Boolean(env['VERCEL'])
    || Boolean(env['VERCEL_ENV'])
    || Boolean(env['VERCEL_URL'])
    || Boolean(env['VERCEL_PROJECT_PRODUCTION_URL']);
  if (isVercel) {
    // Vercel URL이 있으면 사용, 없으면 하드코딩된 production URL
    return normalizeHostAsUrl(env['VERCEL_PROJECT_PRODUCTION_URL'])
      ?? normalizeHostAsUrl(env['VERCEL_URL'])
      ?? PRODUCTION_APP_URL;
  }

  // 로컬 개발 환경
  return LOCAL_APP_URL;
}

export function buildAbsoluteMemoLink(memoId: string, appUrl: string | null | undefined, env: NodeJS.ProcessEnv = process.env) {
  const baseUrl = resolveAppUrl(appUrl, env);
  const params = new URLSearchParams({ id: memoId });
  return `${baseUrl}/memos?${params.toString()}`;
}

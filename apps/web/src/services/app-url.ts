const LOCAL_APP_URL = 'http://localhost:3108';

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
  // 1. 명시적으로 전달된 appUrl
  const explicit = normalizeUrl(appUrl);
  if (explicit) return explicit;

  // 2. APP_BASE_URL — Amplify/custom 배포 시 직접 설정 (최우선 env)
  const appBaseUrl = normalizeUrl(env['APP_BASE_URL']);
  if (appBaseUrl) return appBaseUrl;

  // 3. NEXT_PUBLIC_APP_URL
  const nextPublicAppUrl = normalizeUrl(env['NEXT_PUBLIC_APP_URL']);
  if (nextPublicAppUrl) return nextPublicAppUrl;

  // 4. Vercel auto env
  const vercelUrl = normalizeHostAsUrl(env['VERCEL_PROJECT_PRODUCTION_URL'])
    ?? normalizeHostAsUrl(env['VERCEL_URL']);
  if (vercelUrl) return vercelUrl;

  // 5. 로컬 개발 환경 fallback
  return LOCAL_APP_URL;
}

export function buildAbsoluteMemoLink(memoId: string, appUrl: string | null | undefined, env: NodeJS.ProcessEnv = process.env) {
  const baseUrl = resolveAppUrl(appUrl, env);
  const params = new URLSearchParams({ id: memoId });
  return `${baseUrl}/memos?${params.toString()}`;
}

// story #4443 PR2 — every date here is drawn in a zone the caller names (the viewer's — useViewerTimeZone — for when something
// happened). Without one, Intl took the runtime's: the server's UTC in a server render, the browser's after.
export function formatLocaleDate(
  value: string | number | Date,
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions | undefined,
  timeZone: string,
) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const resolvedLocale = locale || 'en';

  try {
    return new Intl.DateTimeFormat(resolvedLocale, { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en', { ...options, timeZone }).format(date);
  }
}

export function formatLocaleDateTime(value: string | number | Date, locale: string | undefined, timeZone: string) {
  return formatLocaleDate(value, locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }, timeZone);
}

export function formatLocaleDateOnly(value: string | number | Date, locale: string | undefined, timeZone: string) {
  return formatLocaleDate(value, locale, {
    dateStyle: 'medium',
  }, timeZone);
}

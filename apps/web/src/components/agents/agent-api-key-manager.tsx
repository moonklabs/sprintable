'use client';

import { useState, useEffect, useCallback, useId, useRef, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { Textarea } from '@/components/ds/input';
import { NativeSelect } from '@/components/ds/select';
import { DetailCard } from '@/components/agents/detail-card';
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ds/dialog';
import { Input } from '@/components/ds/input';
import { useToast } from '@/components/ui/toast';
import { ToolPermissionPicker } from '@/components/agents/tool-permission-picker';
import { copyTextSafely } from '@/lib/clipboard';

import { fetchWithAuth } from '@/lib/db/client';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { formatViewerScheduledAt } from '@/lib/schedule-format';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

interface ApiKey {
  id: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  scope: string[] | null;
}

interface AgentApiKeyManagerProps {
  agentId: string;
  agentName: string;
  /** [SID:4311 PR 3] 머리 줄에만 쓰는 목록 라벨(같은 이름 둘이면 «· ID 앞 8자» · 이름 빔 = «이름 없는 에이전트»). 에이전트에게 보내는 온보딩 문구는 agentName 그대로. */
  agentLabel?: string;
  onNewKey?: (apiKey: string, mcpConfig?: string | null) => void;
  /** story 4912 (A2): told after every SUCCESSFUL read of the key list how many keys are active — the detail's side summary says «활성 키 있음/없음» from it (so a revoke or a re-issue is reflected, and a failed read says nothing). */
  onKeysRead?: (activeCount: number) => void;
  /** story 4912 (B1): inside the «키 관리» panel the panel's own title names the agent — the card skips its title + description (the buttons and everything else stay). */
  compact?: boolean;
  /** story 4912 (B1, codex): true from the moment a new key is being issued (the old keys may already be revoked) until the create answer is in. The «키 관리» panel does not close in that window — closing unmounts this card, and a create answer with nobody to show it to is a key that exists and can never be read. */
  onIssuingChange?: (issuing: boolean) => void;
}

/**
 * story 4889 (codex, three rounds on the same gap): one card = ONE agent. Everything that lives in it — the keys, the failure line, `loading`, the new-key dialog, the generate / revoke
 * still out — belongs to that agent, so a different agent is a different card (`key`): a late answer of an earlier agent lands in a card that is gone. (Checking «is this still my
 * agent?» in every callback was one more spelling of the same gap each round.)
 */
export function AgentApiKeyManager(props: AgentApiKeyManagerProps) {
  return <AgentApiKeyManagerCard key={props.agentId} {...props} />;
}

/** the create answer's body must arrive within this long once its headers did */
const CREATE_BODY_TIMEOUT_MS = 20_000;

async function readJsonWithin(response: Response, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      response.json(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CreateBodyTimeoutError('response body timed out')), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** the create answer's headers came but its body did not finish: the key may EXIST on the server (the old keys are already revoked) while nobody can read it */
class CreateBodyTimeoutError extends Error {}

function AgentApiKeyManagerCard({ agentId, agentName, agentLabel, onNewKey, onKeysRead, compact = false, onIssuingChange }: AgentApiKeyManagerProps) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const locale = useLocale();
  const keyDialogTitleId = useId(); // the ds Dialog needs its accessible name (the title)
  const expiryId = useId(); // one per card: two managers on a page (the keys screen's panel and a detail) must not share an id (a label would bind to the first select)
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(false);
  // story 4889 (AC3 §5-8): a failed read was a toast and then «키가 없어요» — which a failed read is not. The list area says the read failed, with [다시 시도] (the same read as [새로고침]).
  const [loadFailed, setLoadFailed] = useState(false);
  const [refocus, setRefocus] = useState(false); // the failure's [다시 시도] was pressed: once its read is done and worked, the focus goes to [새로고침] (the pressed button is gone)
  const [newKeyDialog, setNewKeyDialog] = useState(false);
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  // EF-S3: mcp_config is captured-at-creation (returned once with the plaintext key) so the
  // onboarding copy can bundle the agent's MCP server config alongside the key.
  const [generatedMcpConfig, setGeneratedMcpConfig] = useState<string | null>(null);
  // 툴 권한 = 그룹키 배열(=api-key.scope). picker가 카탈로그 로드 후 전체 비파괴로 기본 초기화.
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  // story #2838(PO AC 확定 2026-08-20) — 발급 UI에 만료 선택이 아예 없어 90일이 몰래
  // 각인되던 결함(유나 세션 침묵 실사고). 이제 발급자가 항상 명시 선택(기본값도 화면에
  // 보이는 채)하고, 그 선택을 그대로 API에 전송한다(서버도 이 값을 필수로 강제 —
  // api_key.py CreateApiKeyRequest.expires_at 기본값 제거와 짝).
  type ExpiryChoice = '30d' | '90d' | '180d' | '365d' | 'never';
  const [selectedExpiry, setSelectedExpiry] = useState<ExpiryChoice>('90d');
  const computeExpiresAt = (choice: ExpiryChoice): string | null => {
    if (choice === 'never') return null;
    const days = { '30d': 30, '90d': 90, '180d': 180, '365d': 365 }[choice];
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  };
  const [copiedOnboarding, setCopiedOnboarding] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  // story #3986 CHANGES(페드루 PO C2) — 헤더의 「온보딩 메시지 복사」는 다이얼로그가
  // 닫혀 있을 때도 쓸 수 있는데, 그 메시지 본문은 이 화면 어디에도 안 떠 있다.
  // 실패했을 때만 본문을 선택 가능하게 노출한다.
  const [copyFailedOnboardingMessage, setCopyFailedOnboardingMessage] = useState<string | null>(null);
  const openKeyDialog = () => { keyDialogOpenRef.current = true; setNewKeyDialog(true); };
  // every way of closing the dialog (the [완료] button, Esc, a click outside, the X) goes through here: bump the generation (jobs started before it can no longer write) and clear everything that carries the key.
  const closeNewKeyDialog = () => {
    keyGenRef.current += 1;
    keyDialogOpenRef.current = false;
    setNewKeyDialog(false);
    setGeneratedKey(null);
    setGeneratedMcpConfig(null);
    setCopyFailedOnboardingMessage(null);
  };
  /** The only writer of key-carrying state. `held` = the generation the job took when it started. `reopen` is the create-key answer's exception (a fresh generation + the dialog opens). */
  const writeKeyState = (held: number, apply: () => void, reopen = false) => {
    if (held === keyGenRef.current && keyDialogOpenRef.current) { apply(); return; }
    if (!reopen) return;
    keyGenRef.current += 1;
    keyDialogOpenRef.current = true;
    setNewKeyDialog(true);
    apply();
  };
  const [revokeConfirmDialog, setRevokeConfirmDialog] = useState(false);
  // story #2416 — 개별 키 revoke의 native confirm() 대체. null=닫힘, 아니면 대상 키 id.
  const [revokeKeyId, setRevokeKeyId] = useState<string | null>(null);
  const { addToast } = useToast();
  // story 4889 (codex): this card belongs to ONE agent — once it is gone (the person went to another agent), what it still has in flight must not reach the page: no new-key callback (the plaintext key would land on the OTHER agent's screen), no toast
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  // story 4912 D4 — ONE device for «nothing that carries the plaintext key is written once the key-shown dialog is gone».
  // The key-carrying state (full key · MCP config · the failed-copy message) is written only through `writeKeyState`. An async job takes `keyGenRef.current` when it STARTS and writes
  // only if that generation is still the current one AND the dialog is open; closing bumps the generation and clears everything. The one exception is the create-key answer: the old key
  // is already revoked, so a late answer is not dropped but opens the dialog again under a fresh generation (`reopen`) to be shown once.
  const keyGenRef = useRef(0);
  const keyDialogOpenRef = useRef(false);
  const notify = useCallback((toast: Parameters<typeof addToast>[0]) => { if (aliveRef.current) addToast(toast); }, [addToast]);

  // 문서 app 단일화(2026-08-10 선생님 지시): app 자기 도메인 canonical 직지정(랜딩 301 제거로 app.sprintable.ai 가 자기 /llms.txt 를 직접 서빙).
  const LLMS_URL = 'https://app.sprintable.ai/llms.txt';

  const buildOnboardingMessage = (apiKey: string, mcpConfig?: string | null) =>
    t('agentApiKeyOnboardingMessageBase', { agentName, apiKey, llmsUrl: LLMS_URL }) +
    (mcpConfig ? t('agentApiKeyOnboardingMessageMcpSuffix', { mcpConfig }) : '');

  // story 4889 (codex): only the LATEST read writes — an older read (the read before a re-run of the load effect · an earlier press) answering late must not set the keys, the failure line or `loading` over a newer one
  const readSeq = useRef(0);
  const refreshRef = useRef<HTMLButtonElement>(null); // this card's own [새로고침] (the API-key page holds several cards — never a global lookup)
  // the callback lives in a ref: a parent that passes a new function every render must not re-run the load (the load effect depends on loadApiKeys)
  const onKeysReadRef = useRef(onKeysRead);
  const onIssuingChangeRef = useRef(onIssuingChange);
  useEffect(() => { onKeysReadRef.current = onKeysRead; onIssuingChangeRef.current = onIssuingChange; });
  // story 4912 (B2, codex): ONLY this card's own hold is ever released by this card, and once — an edge-triggered report. «발급 중» now ends at the state write, so the same card's later `finally` (and a card that has already been unmounted) must not clear a hold a NEWER panel has taken since.
  const issuingRef = useRef(false);
  const reportIssuing = (issuing: boolean) => {
    if (issuingRef.current === issuing) return;
    issuingRef.current = issuing;
    onIssuingChangeRef.current?.(issuing);
  };
  // a card that goes away while it still holds the panel (the agent list changed under it) lets go of it
  useEffect(() => () => { if (issuingRef.current) { issuingRef.current = false; onIssuingChangeRef.current?.(false); } }, []);
  const loadApiKeys = useCallback(async () => {
    if (!agentId) return;
    const seq = ++readSeq.current;
    setLoading(true);
    try {
      const response = await fetchWithAuth(`/api/agents/${agentId}/api-key`);
      if (!response.ok) throw new Error('Failed to load API keys');
      const result = await response.json() as { data?: ApiKey[] };
      if (seq !== readSeq.current) return;
      setApiKeys(result.data ?? []);
      setLoadFailed(false);
      if (aliveRef.current) onKeysReadRef.current?.((result.data ?? []).filter((k) => !k.revoked_at).length);
    } catch (error) {
      console.error('[agent-api-key] load failed', error);
      if (seq !== readSeq.current) return;
      setLoadFailed(true);
      notify({
        type: 'error',
        title: tc('error'),
        // story #4359(까디르) — 화면엔 늘 ko 키 · 원인(영어 Error 메시지)은 로그로만.
        body: t('agentApiKeyLoadFailed'),
      });
    } finally {
      if (seq === readSeq.current) setLoading(false);
    }
  }, [agentId, notify, t, tc]);

  useEffect(() => {
    if (!refocus || loading) return;
    if (!loadFailed) refreshRef.current?.focus();
    setRefocus(false);
  }, [refocus, loading, loadFailed]);

  // Load API keys on mount
  useEffect(() => {
    void loadApiKeys();
  }, [loadApiKeys]);

  const generateApiKey = async () => {
    if (!agentId) return;
    const heldGen = keyGenRef.current;
    setLoading(true);
    reportIssuing(true);
    try {
      const response = await fetchWithAuth(`/api/agents/${agentId}/api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: selectedScopes, expires_at: computeExpiresAt(selectedExpiry) }),
      });
      if (!response.ok) throw new Error('Failed to generate API key');
      // story 4912 (B2, codex): `fetchWithAuth` times out the response HEADERS only — a create answer whose body never ends would hold «발급 중» (and the panel) forever. A bounded read turns that into the ordinary «발급 실패» path.
      const result = await readJsonWithin(response, CREATE_BODY_TIMEOUT_MS) as { data?: { api_key?: string; mcp_config?: unknown } };
      if (!aliveRef.current) return; // the card is gone (another agent now): the key made for THIS agent is not shown on that one's page
      const rawKey = (result.data?.api_key ?? '') as string;
      const rawMcp = result.data?.mcp_config;
      const mcpConfigStr = rawMcp == null ? null : typeof rawMcp === 'string' ? rawMcp : JSON.stringify(rawMcp, null, 2);
      writeKeyState(heldGen, () => { setGeneratedKey(rawKey); setGeneratedMcpConfig(mcpConfigStr); }, true);
      reportIssuing(false); // story 4912 (B2): «발급 중» ends the moment the key is in the dialog's state (the follow-up list read below is not worth holding a panel for)
      onNewKey?.(rawKey, mcpConfigStr);
      await loadApiKeys();
    } catch (error) {
      console.error('[agent-api-key] generate failed', error);
      if (error instanceof CreateBodyTimeoutError) {
        // story 4912 (B2, codex): NOT «발급 실패» — the new key may exist (and the old ones are already revoked) while its plaintext never reached this screen. Say so, and read the list so what exists is on screen.
        notify({ type: 'error', title: tc('error'), body: t('agentApiKeyCreateUnconfirmed') });
        reportIssuing(false); // the create is over — the list read below (whose own body is unbounded) must not hold the panel (codex round 2)
        await loadApiKeys();
      } else {
        notify({
          type: 'error',
          title: tc('error'),
          // story #4359(까디르) — 화면엔 늘 ko 키 · 원인(영어 Error 메시지)은 로그로만.
          body: t('agentApiKeyGenerateFailed'),
        });
      }
    } finally {
      setLoading(false);
      reportIssuing(false);
    }
  };

  const revokeAllAndGenerate = async () => {
    if (!agentId) return;
    setRevokeConfirmDialog(false);
    setLoading(true);
    reportIssuing(true); // the old keys are being revoked: from here until the new key's answer the panel stays
    try {
      await Promise.all(
        activeKeys.map((key) =>
          fetchWithAuth(`/api/agents/${agentId}/api-key/${key.id}`, { method: 'DELETE' })
        )
      );
    } catch {
      // 일부 revoke 실패해도 신규 발급은 진행
    } finally {
      setLoading(false);
    }
    openKeyDialog();
    void generateApiKey();
  };

  const revokeApiKey = async (keyId: string) => {
    if (!agentId) return;

    setLoading(true);
    try {
      const response = await fetchWithAuth(`/api/agents/${agentId}/api-key/${keyId}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Failed to revoke API key');
      await loadApiKeys();
      notify({
        type: 'success',
        title: t('agentApiKeyRevokedTitle'),
        body: t('agentApiKeyRevokedBody'),
      });
    } catch (error) {
      console.error('[agent-api-key] revoke failed', error);
      notify({
        type: 'error',
        title: tc('error'),
        // story #4359(까디르) — 화면엔 늘 ko 키 · 원인(영어 Error 메시지)은 로그로만.
        body: t('agentApiKeyRevokeFailed'),
      });
    } finally {
      setLoading(false);
    }
  };

  // story #3986(클래스 «거짓 성공 표시») — 이 파일의 writeToClipboard(execCommand
  // 폴백+실패 시 throw)가 선례였다. 공용 lib/clipboard.ts::copyTextSafely로
  // 일반화됐으니(발명 0, 로직 그대로) 여기 로컬 사본은 걷는다.
  const copyToClipboard = async (text: string) => {
    const result = await copyTextSafely(text);
    if (!result.ok) {
      addToast({ type: 'error', title: t('agentApiKeyCopyFailTitle'), body: tc('copyFailedSelectManually') });
      return;
    }
    setCopiedKey(true);
    addToast({ type: 'success', title: t('agentApiKeyCopiedTitle'), body: t('agentApiKeyCopiedBody') });
    window.setTimeout(() => setCopiedKey(false), 1500);
  };

  // `carriesKey` = the message holds the fresh full key (not just a listed key's prefix): only then is the failed-copy textarea key-carrying state and goes through the writer's generation check
  // (a copy that fails AFTER the dialog was closed must not bring the message back).
  const copyOnboardingMessage = async (apiKey: string, mcpConfig?: string | null, carriesKey = false) => {
    const message = buildOnboardingMessage(apiKey, mcpConfig);
    const heldGen = keyGenRef.current;
    const result = await copyTextSafely(message);
    if (!result.ok) {
      addToast({ type: 'error', title: t('agentApiKeyCopyFailTitle'), body: tc('copyFailedSelectManually') });
      if (carriesKey) writeKeyState(heldGen, () => setCopyFailedOnboardingMessage(message));
      else setCopyFailedOnboardingMessage(message);
      return;
    }
    setCopyFailedOnboardingMessage(null);
    setCopiedOnboarding(true);
    addToast({ type: 'success', title: t('agentApiKeyOnboardingCopiedTitle') });
    window.setTimeout(() => setCopiedOnboarding(false), 1500);
  };


  const activeKeys = apiKeys.filter((k) => !k.revoked_at);

  return (
    <KeyManagerFrame compact={compact} title={t('agentApiKeyListTitle', { name: agentLabel ?? agentName })} description={t('agentApiKeyListDescription')}>
      {/* story 4889 — 402폭 가로 넘침(실측: 스크롤러 scrollWidth 487 > 402): 머리가 «제목 | 버튼 셋(333px 한 줄)»이라 좁은 폭에서 버튼 줄이 카드 밖으로 밀렸다. 줄바꿈을 허용하고(flex-wrap) 제목 칸은 줄어들 수 있게(min-w-0) 한다. */}
      <div className="flex flex-wrap items-start justify-end gap-3">
        <div className="flex min-w-0 flex-col items-end gap-2">
          <div className="flex flex-wrap justify-end gap-2">
            <Button ref={refreshRef} variant="secondary" onClick={loadApiKeys} disabled={loading} data-testid="agent-api-key-refresh">
              {t('agentApiKeyRefresh')}
            </Button>
            <Button
              variant="secondary"
              // story 4912 D5 — the onboarding message needs the FULL key. Without a fresh key this button copied «{prefix}...» (a message the agent cannot use), so it is only on while a fresh key is held.
              disabled={generatedKey === null || copiedOnboarding}
              onClick={() => { if (generatedKey !== null) void copyOnboardingMessage(generatedKey, generatedMcpConfig, true); }}
            >
              {copiedOnboarding ? <Check className="h-3.5 w-3.5 text-ds-done" /> : <Copy className="h-3.5 w-3.5" />}
              {t('agentApiKeyCopyOnboardingCta')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (activeKeys.length > 0) {
                  setRevokeConfirmDialog(true);
                } else {
                  openKeyDialog();
                  void generateApiKey();
                }
              }}
              disabled={loading}
            >
              {/* story 4912 (PO 11-12): the button names what it does — with a key already there, pressing it asks «무효화하고 새 키 발급», so it says «새 키로 바꾸기» (no key yet: «API 키 발급») */}
              {activeKeys.length > 0 ? t('agentApiKeyReplaceCta') : t('agentApiKeyGenerate')}
            </Button>
          </div>
          {copyFailedOnboardingMessage ? (
            <Textarea
              readOnly
              value={copyFailedOnboardingMessage}
              onFocus={(e) => e.currentTarget.select()}
              className="resize-none p-2 font-mono text-ds-small"
              rows={4}
              data-testid="agent-api-key-copy-failed-raw-onboarding-message"
            />
          ) : null}
        </div>
      </div>

      {/* 툴 권한 picker (2da32fbf) — 선택 그룹키가 신규 키의 scope로 바인딩된다. */}
      <div>
        <ToolPermissionPicker
          value={selectedScopes}
          onChange={setSelectedScopes}
          disabled={loading}
        />
      </div>

      {/* story #2838 — 만료 선택(항상 화면에 노출, 침묵 각인 금지). */}
      <div>
        <label htmlFor={expiryId} className="mb-1 block text-ds-small font-medium text-ds-ink">{t('agentApiKeyExpiryLabel')}</label>
        <NativeSelect
          id={expiryId}
          className="w-48"
          value={selectedExpiry}
          disabled={loading}
          onChange={(e) => setSelectedExpiry(e.target.value as ExpiryChoice)}
        >
          <option value="30d">{t('agentApiKeyExpiry30d')}</option>
          <option value="90d">{t('agentApiKeyExpiry90d')}</option>
          <option value="180d">{t('agentApiKeyExpiry180d')}</option>
          <option value="365d">{t('agentApiKeyExpiry365d')}</option>
          <option value="never">{t('agentApiKeyExpiryNever')}</option>
        </NativeSelect>
      </div>

      {loadFailed ? (
        <div className="flex flex-wrap items-center gap-3" data-testid="agent-api-key-load-failed">
          <p role="status" className="text-ds-small text-ds-ink">{t('agentApiKeyLoadFailed')}</p>
          {/* the retry button goes away once the read works — the focus goes to [새로고침] then (never to the page) */}
          <Button variant="secondary" disabled={loading} onClick={() => { setRefocus(true); void loadApiKeys(); }}>{tc('retry')}</Button>
        </div>
      ) : null}
      {apiKeys.length === 0 ? (
        loadFailed ? null : <p className="text-ds-small text-ds-ink-3">{t('agentApiKeyEmpty')}</p>
      ) : (
        <div className="space-y-2">
          {apiKeys.map((key) => (
            <div
              key={key.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-ds-control bg-ds-surface-sunk p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="shrink-0 font-mono text-ds-small text-ds-ink">{key.key_prefix}...</p>
                  {(key.scope ?? ['read', 'write']).map((s) => (
                    <Chip key={s} title={s} tone={s === 'admin' ? 'needs-hand' : 'neutral'} className="max-w-full truncate">
                      {s}
                    </Chip>
                  ))}
                </div>
                {/* story #3493 — created_at/last_used_at/revoked_at은 "기록"(정본
                    formatRelativeTime). expires_at은 미래 만료 "약속"이라 상대시각으로
                    decay시키면 안 됨(음수 diff가 clamp돼 "지금"으로 오표시) — §11-2
                    정본(formatScheduledAt)으로 절대 표기. */}
                <p className="text-ds-small text-ds-ink-3">
                  {t('agentApiKeyCreatedAt', { time: formatViewerRelativeTime(key.created_at, locale, displayTimezone) })}
                  {key.last_used_at && <>{' · '}{t('agentApiKeyLastUsedAt', { time: formatViewerRelativeTime(key.last_used_at, locale, displayTimezone) })}</>}
                  {key.revoked_at && <>{' · '}{t('agentApiKeyRevokedAt', { time: formatViewerRelativeTime(key.revoked_at, locale, displayTimezone) })}</>}
                </p>
                {key.expires_at && !key.revoked_at && (() => {
                  const expiresDate = new Date(key.expires_at);
                  const daysLeft = Math.ceil((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                  const isExpired = daysLeft <= 0;
                  const isWarning = daysLeft > 0 && daysLeft <= 7;
                  const expiresDisplay = formatViewerScheduledAt(key.expires_at, displayTimezone).display;
                  return (
                    <p className={`mt-0.5 text-ds-small ${isExpired ? 'font-medium text-ds-failed' : isWarning ? 'font-medium text-ds-needs-hand' : 'text-ds-ink-3'}`}>
                      {isExpired
                        ? t('agentApiKeyExpiredAt', { date: expiresDisplay })
                        : isWarning
                          ? <><span aria-hidden="true">⚠ </span>{t('agentApiKeyExpiresInDays', { days: daysLeft, date: expiresDisplay })}</>
                          : t('agentApiKeyExpiresAt', { date: expiresDisplay })}
                    </p>
                  );
                })()}
              </div>
              {!key.revoked_at && (
                <Button
                  variant="danger"
                  onClick={() => setRevokeKeyId(key.id)}
                  disabled={loading}
                >
                  {t('agentApiKeySingleRevokeConfirmCta')}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={revokeConfirmDialog}
        onOpenChange={setRevokeConfirmDialog}
        title={t('agentApiKeyRevokeDialogTitle')}
        description={t('agentApiKeyRevokeDialogBody', { count: activeKeys.length })}
        cancelLabel={tc('cancel')}
        confirmLabel={t('agentApiKeyRevokeConfirmCta')}
        tone="danger"
        onConfirm={() => void revokeAllAndGenerate()}
      />

      <ConfirmDialog
        open={revokeKeyId !== null}
        onOpenChange={(open) => { if (!open) setRevokeKeyId(null); }}
        title={t('agentApiKeySingleRevokeDialogTitle')}
        description={t('agentApiKeySingleRevokeDialogBody')}
        cancelLabel={tc('cancel')}
        confirmLabel={t('agentApiKeySingleRevokeConfirmCta')}
        tone="danger"
        onConfirm={() => {
          const id = revokeKeyId;
          setRevokeKeyId(null);
          if (id) void revokeApiKey(id);
        }}
      />

      <Dialog open={newKeyDialog} onOpenChange={(open) => { if (open) openKeyDialog(); else closeNewKeyDialog(); }}>
        <DialogContent className="sm:max-w-lg" aria-labelledby={keyDialogTitleId}>
          <DialogHeader>
            <DialogTitle id={keyDialogTitleId}>{t('agentApiKeyGeneratedTitle')}</DialogTitle>
            <DialogDescription>
              {t('agentApiKeyShownOnce')}
            </DialogDescription>
          </DialogHeader>
          {generatedKey && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="generated-api-key" className="text-ds-small font-medium leading-none text-ds-ink select-none">{t('agentApiKeyFieldLabel')}</label>
                <div className="flex gap-2">
                  <Input
                    id="generated-api-key"
                    value={generatedKey}
                    readOnly
                    className="font-mono"
                  />
                  <Button variant="secondary" onClick={() => void copyToClipboard(generatedKey)} className="shrink-0">
                    {copiedKey ? <Check className="h-3.5 w-3.5 text-ds-done" /> : <Copy className="h-3.5 w-3.5" />}
                    {copiedKey ? t('agentApiKeyKeyCopiedLabel') : t('agentApiKeyCopyKeyCta')}
                  </Button>
                </div>
              </div>
              <p className="text-ds-small text-ds-ink-3">
                {t('agentApiKeyHeaderHint')}
                <code className="mt-1 block break-all rounded-ds-control bg-ds-surface-sunk p-2 font-mono text-ds-small text-ds-ink">
                  Authorization: Bearer {generatedKey}
                </code>
              </p>
              <div className="rounded-ds-control bg-ds-surface-sunk p-2">
                <p className="text-ds-small font-medium text-ds-ink">{t('agentApiKeyScopeLabel')}</p>
                <p className="mt-1 break-all font-mono text-ds-small text-ds-ink-3">
                  {['core', ...selectedScopes].join(' · ')}
                </p>
              </div>
              <div className="border-t border-ds-line pt-2">
                <p className="mb-2 text-ds-small text-ds-ink-3">{t('agentApiKeyOnboardingInstruction')}</p>
                <pre className="whitespace-pre-wrap break-all rounded-ds-control bg-ds-surface-sunk p-2 text-ds-small text-ds-ink">{buildOnboardingMessage(generatedKey, generatedMcpConfig)}</pre>
                <Button
                  variant="secondary"
                  className="mt-2"
                  onClick={() => void copyOnboardingMessage(generatedKey, generatedMcpConfig, true)}
                >
                  {copiedOnboarding ? <Check className="h-3.5 w-3.5 text-ds-done" /> : <Copy className="h-3.5 w-3.5" />}
                  {t('agentApiKeyCopyOnboardingCta')}
                </Button>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="primary"
              onClick={closeNewKeyDialog}
            >
              {t('agentApiKeyDone')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </KeyManagerFrame>
  );
}

/** story 4912 (C3): on the detail's «키» tab the manager is a ds card (title + description in its header, like its sibling cards); inside the «키 관리» panel (`compact`) the panel is already the surface, so the content sits on it directly — no card in a panel. */
function KeyManagerFrame({ compact, title, description, children }: { compact?: boolean; title: string; description: string; children: ReactNode }) {
  if (compact) return <div className="space-y-4" data-testid="agent-api-key-manager">{children}</div>;
  return <DetailCard data-testid="agent-api-key-manager" title={title} description={description}>{children}</DetailCard>;
}

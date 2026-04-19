import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Sparkles,
  RefreshCw,
  AlertTriangle,
  ShieldAlert,
  Globe,
  Server,
  CheckCircle2,
  Loader2,
  Trash2,
  ExternalLink,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../hooks/use-api';
import type {
  SetupCard,
  SkillSetupResponse,
} from '../../lib/types';

// ── Setup card ──

interface SetupCardViewProps {
  agentId: string;
  card: SetupCard;
  onChange: () => void;
}

function SetupCardView({ agentId, card, onChange }: SetupCardViewProps) {
  const [domainChecks, setDomainChecks] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const d of card.unapprovedDomains) init[d] = true;
    return init;
  });
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const c of card.missingCredentials) init[c.envName] = '';
    return init;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [confirmingDismiss, setConfirmingDismiss] = useState(false);
  // Per-envName state for OAuth "Connect" buttons. `connecting` holds envNames
  // we've opened an auth window for and are waiting on; `connectError` holds
  // per-envName error strings (popup blocked, start endpoint 4xx, etc.).
  const [connecting, setConnecting] = useState<Set<string>>(new Set());
  const [connectError, setConnectError] = useState<Record<string, string>>({});
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-envName 30s re-enable timers (see handleConnect's finally). Tracked
  // in a ref Map so the unmount effect can clear any still-pending timers —
  // otherwise a user navigating away within 30s triggers setConnecting on
  // an unmounted component. React 18 no-ops it silently, but leaks are
  // leaks.
  const connectTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      for (const t of connectTimersRef.current.values()) clearTimeout(t);
      connectTimersRef.current.clear();
    };
  }, []);

  // An OAuth cred still listed in missingCredentials means it's not yet
  // connected. The reconcile after the callback removes it from the list — so
  // any oauth cred we still see is by definition unconnected.
  const hasUnconnectedOAuth = card.missingCredentials.some((c) => c.authType === 'oauth');
  const apiKeyCreds = card.missingCredentials.filter((c) => c.authType === 'api_key');
  // A credential only blocks submit when the user hasn't typed a value AND
  // the server doesn't already have one to reuse. `hasExistingValue` is the
  // server's signal that the approve handler will auto-fill from storage
  // when the request omits this envName — see approveSkillSetup in
  // server-admin-skills-helpers.ts.
  const missingApiKeyValue = apiKeyCreds.some(
    (c) => !c.hasExistingValue && (credentialValues[c.envName] ?? '').trim() === ''
  );

  // Once an approve succeeds we defer the refresh 1.5s so the "Enabled" chip
  // is visible before the card vanishes. During that window both buttons stay
  // visible — disable them so a second click can't fire a duplicate approve
  // (which would 404 once reconcile drops the setup row) or a stray dismiss.
  const approveDisabled =
    submitting || success || hasUnconnectedOAuth || missingApiKeyValue;

  const toggleDomain = useCallback((domain: string) => {
    setDomainChecks((prev) => ({ ...prev, [domain]: !prev[domain] }));
  }, []);

  const setCredentialValue = useCallback((envName: string, value: string) => {
    setCredentialValues((prev) => ({ ...prev, [envName]: value }));
  }, []);

  const handleApprove = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    setErrorDetails(null);

    const creds = apiKeyCreds
      .map((c) => ({ envName: c.envName, value: credentialValues[c.envName] ?? '' }))
      .filter((c) => c.value !== '');

    const approveDomains = card.unapprovedDomains.filter((d) => domainChecks[d]);

    try {
      await api.approveSkill({
        agentId,
        skillName: card.skillName,
        credentials: creds,
        approveDomains,
      });
      setSubmitting(false);
      setSuccess(true);
      successTimerRef.current = setTimeout(() => {
        onChange();
      }, 1500);
    } catch (err) {
      setSubmitting(false);
      // apiFetch hoists the server's `details` string (when present) onto the
      // thrown Error. Approve errors like credential mismatch or OAuth
      // rejection carry a details string; other endpoints leave it undefined.
      const e = err as Error & { details?: string };
      setError(e instanceof Error ? e.message : String(err));
      setErrorDetails(e.details ?? null);
    }
  }, [agentId, card, apiKeyCreds, credentialValues, domainChecks, onChange]);

  const handleConnect = useCallback(
    async (envName: string) => {
      setConnectError((prev) => {
        const next = { ...prev };
        delete next[envName];
        return next;
      });
      setConnecting((prev) => {
        const next = new Set(prev);
        next.add(envName);
        return next;
      });
      try {
        const { authUrl } = await api.startOAuth({
          agentId,
          skillName: card.skillName,
          envName,
        });
        // Open in a new tab. User authorizes; the callback endpoint writes
        // creds + triggers reconcile. The parent page polls every 2s and will
        // auto-remove this card (or this envName) when done.
        const win = window.open(authUrl, '_blank', 'noopener,noreferrer');
        if (!win) {
          setConnectError((prev) => ({
            ...prev,
            [envName]: 'Pop-up blocked. Allow pop-ups and try again.',
          }));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to start OAuth flow';
        setConnectError((prev) => ({ ...prev, [envName]: msg }));
      } finally {
        // Keep the button disabled until the card updates (polling will refresh
        // the card away). If the user closes the popup without authorizing,
        // they can retry after 30s when the button auto-re-enables. Track
        // the timer per-envName so a rapid second click for the same envName
        // replaces the old timer, and so the unmount effect can cancel any
        // pending timers and avoid setState-on-unmounted warnings.
        const prevTimer = connectTimersRef.current.get(envName);
        if (prevTimer) clearTimeout(prevTimer);
        const t = setTimeout(() => {
          setConnecting((prev) => {
            const next = new Set(prev);
            next.delete(envName);
            return next;
          });
          connectTimersRef.current.delete(envName);
        }, 30_000);
        connectTimersRef.current.set(envName, t);
      }
    },
    [agentId, card.skillName]
  );

  const handleDismissClick = useCallback(async () => {
    if (confirmingDismiss) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      setConfirmingDismiss(false);
      try {
        await api.dismissSkill(agentId, card.skillName);
        onChange();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } else {
      setConfirmingDismiss(true);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => {
        setConfirmingDismiss(false);
      }, 3000);
    }
  }, [agentId, card.skillName, confirmingDismiss, onChange]);

  return (
    <div className="card" data-testid={`setup-card-${card.skillName}`}>
      <div className="card-header flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-[14px] font-semibold tracking-tight text-foreground">
              {card.skillName}
            </h4>
            <span className="inline-flex items-center gap-1 rounded-full border border-amber/20 bg-amber/5 px-2 py-0.5 text-[10px] font-medium text-amber">
              Setup Required
            </span>
          </div>
          {card.description && (
            <p className="mt-1 text-[12px] text-muted-foreground">
              {card.description}
            </p>
          )}
        </div>
      </div>

      <div className="card-body space-y-5">
        {/* Network access */}
        {card.unapprovedDomains.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-2">
              <Globe size={14} className="text-sky" strokeWidth={1.8} />
              <h5 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                Network access
              </h5>
            </div>
            <p className="text-[12px] text-muted-foreground mb-2">
              We'll add these domains to this agent's allowlist. Uncheck any you'd
              rather we not touch.
            </p>
            <ul className="space-y-1.5">
              {card.unapprovedDomains.map((domain) => (
                <li key={domain} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id={`domain-${agentId}-${card.skillName}-${domain}`}
                    checked={!!domainChecks[domain]}
                    onChange={() => toggleDomain(domain)}
                    className="h-3.5 w-3.5 rounded border-border/60 text-amber focus:ring-amber/30"
                  />
                  <label
                    htmlFor={`domain-${agentId}-${card.skillName}-${domain}`}
                    className="font-mono text-[12px] text-foreground/90 select-none cursor-pointer"
                  >
                    {domain}
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Credentials */}
        {card.missingCredentials.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-2">
              <ShieldAlert size={14} className="text-amber" strokeWidth={1.8} />
              <h5 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                Credentials
              </h5>
            </div>
            <div className="space-y-3">
              {card.missingCredentials.map((cred) => (
                <div key={cred.envName}>
                  {cred.authType === 'oauth' ? (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-foreground/[0.02] px-3 py-2">
                        <span className="text-[12px] text-foreground/90 font-mono">
                          {cred.envName}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          ({cred.scope}-scoped)
                        </span>
                        <button
                          type="button"
                          onClick={() => handleConnect(cred.envName)}
                          disabled={
                            connecting.has(cred.envName) || submitting || success
                          }
                          className="btn-secondary text-[12px] ml-auto flex items-center gap-1.5"
                        >
                          {connecting.has(cred.envName) ? (
                            <>
                              <Loader2 size={12} className="animate-spin" />
                              Opening...
                            </>
                          ) : (
                            <>
                              <ExternalLink size={12} />
                              Connect with {cred.oauth?.provider ?? 'provider'}
                            </>
                          )}
                        </button>
                      </div>
                      {connectError[cred.envName] && (
                        <p className="text-[11px] text-rose">
                          {connectError[cred.envName]}
                        </p>
                      )}
                    </div>
                  ) : (
                    <>
                      <label
                        htmlFor={`cred-${agentId}-${card.skillName}-${cred.envName}`}
                        className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground mb-1.5 block"
                      >
                        {cred.envName}{' '}
                        <span className="text-muted-foreground/70 normal-case">
                          ({cred.scope}-scoped)
                        </span>
                        {cred.hasExistingValue && (
                          <span className="ml-2 text-emerald/80 normal-case">
                            — reusing existing value; paste a new one to replace
                          </span>
                        )}
                      </label>
                      <input
                        id={`cred-${agentId}-${card.skillName}-${cred.envName}`}
                        type="password"
                        autoComplete="off"
                        placeholder={
                          cred.hasExistingValue
                            ? 'Leave blank to reuse existing'
                            : 'Paste your token here'
                        }
                        value={credentialValues[cred.envName] ?? ''}
                        onChange={(e) =>
                          setCredentialValue(cred.envName, e.target.value)
                        }
                        className="input w-full"
                      />
                    </>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* MCP servers */}
        {card.mcpServers.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-2">
              <Server size={14} className="text-violet" strokeWidth={1.8} />
              <h5 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                MCP servers
              </h5>
            </div>
            <p className="text-[12px] text-muted-foreground mb-2">
              These are the MCP endpoints we'll connect to once approved.
            </p>
            <ul className="space-y-1 rounded-lg border border-border/30 bg-foreground/[0.02] divide-y divide-border/20">
              {card.mcpServers.map((srv) => (
                <li
                  key={srv.name}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]"
                >
                  <span className="font-medium text-foreground/90">{srv.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground truncate">
                    {srv.url}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Error banner */}
        {error && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-rose/5 border border-rose/15">
            <AlertTriangle size={14} className="text-rose shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-[13px] text-rose font-medium break-words">
                {error}
              </p>
              {errorDetails && (
                <p className="mt-0.5 text-[11px] text-rose/70 font-mono break-words">
                  {errorDetails}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-border/30">
          <button
            onClick={handleDismissClick}
            className="btn-danger text-[13px] flex items-center gap-1.5"
            disabled={submitting || success}
          >
            <Trash2 size={13} />
            {confirmingDismiss ? 'Confirm dismiss?' : 'Dismiss'}
          </button>
          <div className="flex items-center gap-3">
            {success && (
              <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-emerald">
                <CheckCircle2 size={14} />
                Enabled
              </span>
            )}
            <button
              onClick={handleApprove}
              disabled={approveDisabled}
              className="btn-primary text-[13px] flex items-center gap-1.5"
            >
              {submitting ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  Approving...
                </>
              ) : (
                <>
                  <CheckCircle2 size={13} />
                  Approve &amp; enable
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


// ── Page ──

export default function ApprovalsPage() {
  const {
    data: setup,
    loading: setupLoading,
    error: setupError,
    refresh: refreshSetup,
  } = useApi<SkillSetupResponse>(() => api.skillsSetup(), []);

  const handleRefresh = useCallback(() => {
    refreshSetup();
  }, [refreshSetup]);

  // Auto-poll /skills/setup every 2s while at least one card has an
  // unconnected OAuth credential. The callback endpoint writes the cred and
  // triggers reconcile server-side — polling catches the resulting
  // missingCredentials shrink and re-enables the Approve button (or drops the
  // card entirely). Stops as soon as no OAuth creds are pending.
  useEffect(() => {
    const anyOAuth =
      setup?.agents?.some((a) =>
        a.cards?.some((c) =>
          c.missingCredentials.some((mc) => mc.authType === 'oauth')
        )
      ) ?? false;
    if (!anyOAuth) return;

    const id = setInterval(() => {
      refreshSetup();
    }, 2000);
    return () => clearInterval(id);
  }, [setup, refreshSetup]);

  // Error state — block the page (one error is enough; match the other pages)
  const fatalError = setupError;
  if (fatalError) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle size={40} className="text-rose mb-4" />
        <h2 className="text-lg font-semibold text-foreground mb-2">
          Failed to load approvals
        </h2>
        <p className="text-[13px] text-muted-foreground mb-4">
          {fatalError.message}
        </p>
        <button onClick={handleRefresh} className="btn-primary flex items-center gap-2">
          <RefreshCw size={14} />
          Retry
        </button>
      </div>
    );
  }

  const agentGroups = setup?.agents ?? [];
  const loading = setupLoading && !setup;
  const nothingPending = agentGroups.length === 0;

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div className="flex items-end justify-between animate-fade-in-up">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-amber" strokeWidth={1.8} />
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              Approvals
            </h2>
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground max-w-2xl">
            Pending skills need a few things before they can talk to the outside
            world: some domains on the allowlist, and some credentials we can
            inject into requests. Approve them here and we'll wire the rest.
          </p>
        </div>
        <button
          onClick={handleRefresh}
          className="btn-secondary flex items-center gap-2 text-[13px]"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="skeleton h-32 w-full" />
          ))}
        </div>
      )}

      {/* Setup cards grouped by agent */}
      {!loading && agentGroups.length > 0 && (
        <section className="space-y-6">
          <h3 className="text-[14px] font-semibold tracking-tight text-foreground">
            Setup Required
          </h3>
          {agentGroups.map((group) => (
            <div key={group.agentId} className="space-y-3">
              <h4 className="text-[13px] font-medium text-muted-foreground">
                {group.agentName}
              </h4>
              <div className="space-y-3">
                {group.cards.map((card) => (
                  <SetupCardView
                    key={`${group.agentId}-${card.skillName}`}
                    agentId={group.agentId}
                    card={card}
                    onChange={handleRefresh}
                  />
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Empty state */}
      {!loading && nothingPending && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald/5 border border-emerald/15 mb-4">
            <CheckCircle2 size={22} className="text-emerald" strokeWidth={1.8} />
          </div>
          <h3 className="text-[14px] font-semibold text-foreground mb-1">
            Nothing to approve. Nice.
          </h3>
          <p className="text-[13px] text-muted-foreground max-w-md">
            Every installed skill is set up and happy.
          </p>
        </div>
      )}
    </div>
  );
}

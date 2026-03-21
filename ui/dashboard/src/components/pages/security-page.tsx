import {
  Shield,
  AlertTriangle,
  RefreshCw,
  CheckCircle,
  XCircle,
  Eye,
  Activity,
  ShieldCheck,
  ShieldAlert,
  ShieldX,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../hooks/use-api';
import type { ServerStatus, AuditEntry } from '../../lib/types';

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return d.toLocaleDateString();
}

function ProfileCard({ profile }: { profile: string }) {
  const configs: Record<
    string,
    { color: string; border: string; bg: string; description: string; icon: typeof Shield }
  > = {
    paranoid: {
      color: 'text-rose',
      border: 'border-rose/15',
      bg: 'bg-rose/5',
      description:
        'Maximum security. Every operation is scrutinized. No network access for agents. All content is taint-tagged.',
      icon: Shield,
    },
    balanced: {
      color: 'text-amber',
      border: 'border-amber/15',
      bg: 'bg-amber/5',
      description:
        'Reasonable defaults. Network restricted to allowlisted domains. Content tainting enabled for external sources.',
      icon: Eye,
    },
    yolo: {
      color: 'text-emerald',
      border: 'border-emerald/15',
      bg: 'bg-emerald/5',
      description:
        'Minimal restrictions. Use only in trusted development environments. Not recommended for production.',
      icon: Activity,
    },
  };

  const config = configs[profile] || configs['balanced'];
  const Icon = config.icon;

  return (
    <div className={`card ${config.border}`}>
      <div className="p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${config.bg}`}>
            <Icon size={18} className={config.color} strokeWidth={1.8} />
          </div>
          <div>
            <h3 className="font-semibold text-foreground capitalize">
              {profile}
            </h3>
            <p className="text-[11px] text-muted-foreground">Active Security Profile</p>
          </div>
        </div>
        <p className="text-[13px] text-muted-foreground leading-relaxed">{config.description}</p>
      </div>
    </div>
  );
}

function ThreatEntry({ entry }: { entry: AuditEntry }) {
  return (
    <div className="group flex items-start gap-3 rounded-lg border border-rose/15 bg-rose/5 p-3 transition-colors hover:bg-foreground/[0.02]">
      <div className="mt-0.5 shrink-0">
        <ShieldX className="h-3.5 w-3.5 text-rose" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] font-medium text-foreground/90 truncate">
            {entry.action}
          </p>
          <span className="text-[11px] text-muted-foreground shrink-0">
            {formatTimestamp(entry.timestamp)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground/40">
            {entry.sessionId.slice(0, 12)}...
          </span>
        </div>
        {entry.args && Object.keys(entry.args).length > 0 && (
          <div className="mt-1.5 p-2 rounded-lg bg-background font-mono text-[11px] text-muted-foreground/60 break-all">
            {JSON.stringify(entry.args, null, 0).slice(0, 200)}
            {JSON.stringify(entry.args).length > 200 && '...'}
          </div>
        )}
      </div>
    </div>
  );
}

export default function SecurityPage() {
  const {
    data: status,
    loading: statusLoading,
    error: statusError,
    refresh: refreshStatus,
  } = useApi<ServerStatus>(() => api.status(), []);

  // Security scan events
  const {
    data: scanEvents,
    loading: scansLoading,
  } = useApi<AuditEntry[]>(
    () => api.audit({ action: 'scan', limit: 50 }),
    []
  );

  // Blocked/threat events
  const {
    data: blockedEvents,
    loading: blockedLoading,
  } = useApi<AuditEntry[]>(
    () => api.audit({ result: 'blocked', limit: 50 }),
    []
  );

  if (statusError) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle size={40} className="text-rose mb-4" />
        <h2 className="text-lg font-semibold text-foreground mb-2">
          Failed to load security data
        </h2>
        <p className="text-[13px] text-muted-foreground mb-4">{statusError.message}</p>
        <button onClick={refreshStatus} className="btn-primary">
          <RefreshCw size={14} />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div className="flex items-end justify-between animate-fade-in-up">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Security</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Security profile, scans, and threat monitoring
          </p>
        </div>
        <button
          onClick={refreshStatus}
          className="btn-secondary flex items-center gap-2 text-[13px]"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {/* Security profile */}
      <div className="animate-fade-in-up" style={{ animationDelay: '80ms' }}>
        {statusLoading ? (
          <div className="skeleton h-28 w-full" />
        ) : status ? (
          <ProfileCard profile={status.profile} />
        ) : null}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="card animate-fade-in-up" style={{ animationDelay: '160ms' }}>
          <div className="p-5">
            <div className="flex items-start justify-between">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber/8">
                <Eye size={16} className="text-amber" strokeWidth={1.8} />
              </div>
            </div>
            <div className="mt-4">
              {scansLoading ? (
                <div className="skeleton h-8 w-12" />
              ) : (
                <span className="text-[28px] font-semibold leading-none tracking-tight text-foreground">
                  {scanEvents?.length ?? 0}
                </span>
              )}
            </div>
            <div className="mt-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">Scans</span>
            </div>
          </div>
        </div>
        <div className="card animate-fade-in-up" style={{ animationDelay: '240ms' }}>
          <div className="p-5">
            <div className="flex items-start justify-between">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-rose/8">
                <AlertTriangle size={16} className="text-rose" strokeWidth={1.8} />
              </div>
            </div>
            <div className="mt-4">
              {blockedLoading ? (
                <div className="skeleton h-8 w-12" />
              ) : (
                <span className="text-[28px] font-semibold leading-none tracking-tight text-foreground">
                  {blockedEvents?.length ?? 0}
                </span>
              )}
            </div>
            <div className="mt-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">Blocked</span>
            </div>
          </div>
        </div>
        <div className="card animate-fade-in-up" style={{ animationDelay: '320ms' }}>
          <div className="p-5">
            <div className="flex items-start justify-between">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald/8">
                <CheckCircle size={16} className="text-emerald" strokeWidth={1.8} />
              </div>
            </div>
            <div className="mt-4">
              {scansLoading ? (
                <div className="skeleton h-8 w-12" />
              ) : (
                <span className="text-[28px] font-semibold leading-none tracking-tight text-foreground">
                  {scanEvents?.filter((e) => e.result === 'ok').length ?? 0}
                </span>
              )}
            </div>
            <div className="mt-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">Clean Scans</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Threat patterns (blocked events) */}
        <div className="card animate-fade-in-up" style={{ animationDelay: '400ms' }}>
          <div className="card-header flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldAlert size={16} className="text-rose" strokeWidth={1.8} />
              <h3 className="text-[14px] font-semibold tracking-tight text-foreground">
                Threat Patterns
              </h3>
            </div>
            {blockedEvents && (
              <span className="text-[11px] font-mono text-rose/60">
                {blockedEvents.length} blocked
              </span>
            )}
          </div>
          <div className="card-body">
            {blockedLoading && !blockedEvents ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="skeleton h-16 w-full" />
                ))}
              </div>
            ) : !blockedEvents || blockedEvents.length === 0 ? (
              <div className="text-center py-8">
                <ShieldCheck
                  size={32}
                  className="text-emerald/50 mx-auto mb-3"
                />
                <p className="text-[13px] text-muted-foreground">
                  No threats detected. The nervous crab approves.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {blockedEvents.slice(0, 20).map((entry, i) => (
                  <ThreatEntry
                    key={`${entry.timestamp}-${i}`}
                    entry={entry}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Security scan events */}
        <div className="card animate-fade-in-up" style={{ animationDelay: '480ms' }}>
          <div className="card-header flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Eye size={16} className="text-amber" strokeWidth={1.8} />
              <h3 className="text-[14px] font-semibold tracking-tight text-foreground">
                Security Scans
              </h3>
            </div>
            {scanEvents && (
              <span className="text-[11px] font-mono text-emerald/60">
                {scanEvents.filter((e) => e.result === 'ok').length} pass
              </span>
            )}
          </div>
          <div className="card-body">
            {scansLoading && !scanEvents ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="skeleton h-12 w-full" />
                ))}
              </div>
            ) : !scanEvents || scanEvents.length === 0 ? (
              <div className="text-center py-8 text-[13px] text-muted-foreground">
                No security scans recorded yet
              </div>
            ) : (
              <div className="space-y-1.5">
                {scanEvents.slice(0, 20).map((entry, i) => {
                  const isPass = entry.result === 'ok';
                  return (
                    <div
                      key={`${entry.timestamp}-${i}`}
                      className={`group flex items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-foreground/[0.02] ${
                        isPass
                          ? 'border-emerald/15 bg-emerald/5'
                          : 'border-rose/15 bg-rose/5'
                      }`}
                    >
                      <div className="mt-0.5 shrink-0">
                        {isPass ? (
                          <ShieldCheck className="h-3.5 w-3.5 text-emerald" strokeWidth={2} />
                        ) : (
                          <ShieldX className="h-3.5 w-3.5 text-rose" strokeWidth={2} />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="text-[12px] font-medium text-foreground/90">
                          {entry.action}
                        </span>
                        <div className="mt-1 flex items-center gap-2">
                          <span className="text-[10px] font-mono text-muted-foreground/40">
                            {entry.sessionId.slice(0, 8)}...
                          </span>
                          <span className="text-[10px] text-muted-foreground/20">|</span>
                          <span className="text-[10px] text-muted-foreground/40">
                            {entry.durationMs}ms
                          </span>
                        </div>
                      </div>
                      <span className="text-[11px] text-muted-foreground shrink-0">
                        {formatTimestamp(entry.timestamp)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

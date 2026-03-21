import { useEffect, useState, useCallback } from 'react';
import {
  Activity,
  Users,
  Shield,
  Clock,
  Zap,
  ChevronRight,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  XCircle,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../hooks/use-api';
import type { ServerStatus, Agent, AuditEntry } from '../../lib/types';

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

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

function ResultBadge({ result }: { result: string }) {
  switch (result) {
    case 'ok':
      return (
        <span className="badge-green">
          <CheckCircle size={12} />
          success
        </span>
      );
    case 'error':
      return (
        <span className="badge-red">
          <XCircle size={12} />
          error
        </span>
      );
    case 'blocked':
      return (
        <span className="badge-yellow">
          <AlertTriangle size={12} />
          blocked
        </span>
      );
    default:
      return <span className="badge-zinc">{result}</span>;
  }
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return <span className="badge-green">running</span>;
    case 'idle':
      return <span className="badge-blue">idle</span>;
    case 'stopped':
      return <span className="badge-zinc">stopped</span>;
    case 'error':
      return <span className="badge-red">error</span>;
    default:
      return <span className="badge-zinc">{status}</span>;
  }
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  loading,
  color,
  bgColor,
  delay,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  sub?: string;
  loading: boolean;
  color: string;
  bgColor: string;
  delay: number;
}) {
  return (
    <div
      className="card animate-fade-in-up"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="p-5">
        <div className="flex items-start justify-between">
          <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${bgColor}`}>
            <Icon size={16} className={color} strokeWidth={1.8} />
          </div>
        </div>
        <div className="mt-4">
          {loading ? (
            <div className="skeleton h-8 w-20" />
          ) : (
            <span className="text-[28px] font-semibold leading-none tracking-tight text-foreground">
              {value}
            </span>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[12px] font-medium text-muted-foreground">
            {label}
          </span>
          {sub && (
            <span className="text-[11px] text-muted-foreground/60">
              {sub}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function OverviewPage() {
  const {
    data: status,
    loading: statusLoading,
    error: statusError,
    refresh: refreshStatus,
  } = useApi<ServerStatus>(() => api.status(), []);

  const { data: agents, loading: agentsLoading } = useApi<Agent[]>(
    () => api.agents(),
    []
  );

  const { data: audit, loading: auditLoading } = useApi<AuditEntry[]>(
    () => api.audit({ limit: 20 }),
    []
  );

  // Poll agents every 5 seconds
  const [liveAgents, setLiveAgents] = useState<Agent[] | null>(null);

  const pollAgents = useCallback(async () => {
    try {
      const result = await api.agents();
      setLiveAgents(result);
    } catch {
      // Silently ignore poll failures
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(pollAgents, 5000);
    return () => clearInterval(interval);
  }, [pollAgents]);

  const displayAgents = liveAgents ?? agents;
  const activeAgents = displayAgents?.filter((a) => a.status === 'running');

  if (statusError) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle size={40} className="text-rose mb-4" />
        <h2 className="text-lg font-semibold text-foreground mb-2">
          Connection Error
        </h2>
        <p className="text-[13px] text-muted-foreground mb-4 max-w-md">
          {statusError.message}
        </p>
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
      <div
        className="flex items-end justify-between animate-fade-in-up"
        style={{ animationDelay: '0ms' }}
      >
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Overview
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Real-time system observability and agent orchestration
          </p>
        </div>
        <div className="flex items-center gap-3">
          {status && (
            <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-card px-3 py-1.5">
              <div className="h-1.5 w-1.5 rounded-full bg-emerald animate-pulse-live" />
              <span className="text-[12px] font-medium text-emerald">
                {status.status === 'running' ? 'All systems operational' : status.status}
              </span>
            </div>
          )}
          {status && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber/20 bg-amber/5 px-2 py-0.5 text-[11px] font-medium text-amber">
              {status.profile}
            </span>
          )}
          <button
            onClick={refreshStatus}
            className="btn-secondary flex items-center gap-2 text-[13px]"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Users}
          label="Active Agents"
          value={
            status ? `${status.agents.active} / ${status.agents.total}` : '--'
          }
          sub={activeAgents ? `${activeAgents.length} processing` : undefined}
          loading={statusLoading}
          color="text-amber"
          bgColor="bg-amber/8"
          delay={80}
        />
        <StatCard
          icon={Clock}
          label="Uptime"
          value={status ? formatUptime(status.uptime) : '--'}
          sub="since start"
          loading={statusLoading}
          color="text-violet"
          bgColor="bg-violet/8"
          delay={160}
        />
        <StatCard
          icon={Shield}
          label="Security Profile"
          value={status?.profile ?? '--'}
          loading={statusLoading}
          color="text-emerald"
          bgColor="bg-emerald/8"
          delay={240}
        />
        <StatCard
          icon={Zap}
          label="Total Events"
          value={audit ? String(audit.length) : '--'}
          sub="last 20"
          loading={auditLoading}
          color="text-sky"
          bgColor="bg-sky/8"
          delay={320}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Live agents */}
        <div
          className="card animate-fade-in-up"
          style={{ animationDelay: '400ms' }}
        >
          <div className="card-header flex items-center justify-between">
            <h3 className="text-[14px] font-semibold tracking-tight text-foreground">
              Live Agents
            </h3>
            {activeAgents && (
              <div className="flex items-center gap-1.5">
                <div className="h-1.5 w-1.5 rounded-full bg-amber animate-pulse-live" />
                <span className="text-[11px] font-medium text-muted-foreground">
                  {activeAgents.length} active
                </span>
              </div>
            )}
          </div>
          <div className="card-body">
            {agentsLoading && !displayAgents ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="skeleton h-12 w-full" />
                ))}
              </div>
            ) : !displayAgents || displayAgents.length === 0 ? (
              <div className="text-center py-8 text-[13px] text-muted-foreground">
                No agents running
              </div>
            ) : (
              <div className="space-y-2">
                {displayAgents.map((agent) => (
                  <div
                    key={agent.id}
                    className="group rounded-lg border border-border/30 bg-foreground/[0.02] p-3.5 transition-colors hover:border-border/50 hover:bg-foreground/[0.03]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold text-foreground">
                            {agent.name}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                          {agent.agentType}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <StatusBadge status={agent.status} />
                        <ChevronRight size={14} className="text-muted-foreground/30" />
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <span className="rounded bg-foreground/[0.03] px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground/40">
                        {agent.agentType}
                      </span>
                      <span className="text-[10px] font-mono text-muted-foreground/30">
                        {agent.id.slice(0, 12)}...
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Recent activity */}
        <div
          className="card animate-fade-in-up"
          style={{ animationDelay: '480ms' }}
        >
          <div className="card-header flex items-center justify-between">
            <h3 className="text-[14px] font-semibold tracking-tight text-foreground">
              Recent Activity
            </h3>
            {audit && (
              <span className="text-[11px] font-medium text-muted-foreground">
                Last {audit.length} events
              </span>
            )}
          </div>
          <div className="card-body">
            {auditLoading && !audit ? (
              <div className="space-y-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="skeleton h-10 w-full" />
                ))}
              </div>
            ) : !audit || audit.length === 0 ? (
              <div className="text-center py-8 text-[13px] text-muted-foreground">
                No activity recorded yet
              </div>
            ) : (
              <div className="space-y-1">
                {audit.slice(0, 20).map((entry, i) => (
                  <div
                    key={`${entry.timestamp}-${i}`}
                    className="flex items-center justify-between py-2 px-2 rounded-lg hover:bg-foreground/[0.02] transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <ResultBadge result={entry.result} />
                      <div className="min-w-0">
                        <p className="text-[12px] font-medium text-foreground/90 truncate">
                          {entry.action}
                        </p>
                        <p className="text-[10px] font-mono text-muted-foreground/40">
                          {entry.sessionId.slice(0, 8)}...
                        </p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[11px] text-muted-foreground">
                        {formatTimestamp(entry.timestamp)}
                      </p>
                      <p className="text-[10px] text-muted-foreground/50">
                        {entry.durationMs}ms
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

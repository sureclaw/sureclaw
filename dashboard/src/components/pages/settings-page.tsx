import {
  Settings,
  Server,
  Shield,
  RefreshCw,
  AlertTriangle,
  Clock,
  Key,
  Terminal,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../hooks/use-api';
import type { ServerStatus, ServerConfig } from '../../lib/types';

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  return `${mins}m ${secs}s`;
}

function ConfigSection({
  title,
  icon: Icon,
  data,
}: {
  title: string;
  icon: typeof Settings;
  data: Record<string, unknown> | undefined;
}) {
  if (!data || Object.keys(data).length === 0) {
    return (
      <div className="card">
        <div className="card-header flex items-center gap-2">
          <Icon size={16} className="text-amber" strokeWidth={1.8} />
          <h3 className="text-[14px] font-semibold tracking-tight text-foreground">{title}</h3>
        </div>
        <div className="card-body">
          <p className="text-[13px] text-muted-foreground">No configuration set</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header flex items-center gap-2">
        <Icon size={16} className="text-amber" strokeWidth={1.8} />
        <h3 className="text-[14px] font-semibold tracking-tight text-foreground">{title}</h3>
      </div>
      <div className="card-body">
        <div className="space-y-2">
          {Object.entries(data).map(([key, value]) => (
            <div
              key={key}
              className="flex items-start justify-between py-1.5 border-b border-border/30 last:border-0"
            >
              <span className="text-[13px] text-muted-foreground font-mono">{key}</span>
              <span className="text-[13px] text-foreground/70 text-right ml-4 break-all">
                {typeof value === 'object' && value !== null
                  ? JSON.stringify(value, null, 0)
                  : String(value ?? '--')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const {
    data: status,
    loading: statusLoading,
    error: statusError,
    refresh: refreshStatus,
  } = useApi<ServerStatus>(() => api.status(), []);

  const {
    data: config,
    loading: configLoading,
    error: configError,
    refresh: refreshConfig,
  } = useApi<ServerConfig>(() => api.config(), []);

  const error = statusError || configError;
  const loading = statusLoading || configLoading;

  const handleRefresh = () => {
    refreshStatus();
    refreshConfig();
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle size={40} className="text-rose mb-4" />
        <h2 className="text-lg font-semibold text-foreground mb-2">
          Failed to load settings
        </h2>
        <p className="text-[13px] text-muted-foreground mb-4">{error.message}</p>
        <button onClick={handleRefresh} className="btn-primary">
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
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Server configuration (read-only)
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

      {/* Notice */}
      <div
        className="card border-amber/20 animate-fade-in-up"
        style={{ animationDelay: '80ms' }}
      >
        <div className="p-4 flex items-start gap-3">
          <AlertTriangle
            size={18}
            className="text-amber shrink-0 mt-0.5"
            strokeWidth={1.8}
          />
          <div>
            <p className="text-[13px] text-foreground/70">
              Configuration is read-only in the dashboard. To make changes, edit
              your{' '}
              <code className="px-1.5 py-0.5 rounded-md bg-foreground/[0.04] text-amber text-[11px] font-mono">
                ax.yaml
              </code>{' '}
              file and restart the server.
            </p>
          </div>
        </div>
      </div>

      {/* Server info */}
      <div className="card animate-fade-in-up" style={{ animationDelay: '160ms' }}>
        <div className="card-header flex items-center gap-2">
          <Server size={16} className="text-amber" strokeWidth={1.8} />
          <h3 className="text-[14px] font-semibold tracking-tight text-foreground">
            Server Information
          </h3>
        </div>
        <div className="card-body">
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="skeleton h-8 w-full" />
              ))}
            </div>
          ) : status ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex items-center gap-3 p-3 rounded-lg border border-border/30 bg-foreground/[0.02]">
                <div className="flex h-7 w-7 items-center justify-center rounded-md bg-foreground/[0.04]">
                  <Server size={14} className="text-muted-foreground" strokeWidth={1.8} />
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Status</p>
                  <p className="text-[13px] font-medium text-foreground">
                    {status.status}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg border border-border/30 bg-foreground/[0.02]">
                <div className="flex h-7 w-7 items-center justify-center rounded-md bg-foreground/[0.04]">
                  <Clock size={14} className="text-muted-foreground" strokeWidth={1.8} />
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Uptime</p>
                  <p className="text-[13px] font-medium text-foreground">
                    {formatUptime(status.uptime)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg border border-border/30 bg-foreground/[0.02]">
                <div className="flex h-7 w-7 items-center justify-center rounded-md bg-foreground/[0.04]">
                  <Shield size={14} className="text-muted-foreground" strokeWidth={1.8} />
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Security Profile</p>
                  <p className="text-[13px] font-medium text-foreground capitalize">
                    {status.profile}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg border border-border/30 bg-foreground/[0.02]">
                <div className="flex h-7 w-7 items-center justify-center rounded-md bg-foreground/[0.04]">
                  <Terminal size={14} className="text-muted-foreground" strokeWidth={1.8} />
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Agents</p>
                  <p className="text-[13px] font-medium text-foreground">
                    {status.agents.active} active / {status.agents.total} total
                  </p>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Configuration sections */}
      {configLoading ? (
        <div className="space-y-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton h-32 w-full" />
          ))}
        </div>
      ) : config ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="animate-fade-in-up" style={{ animationDelay: '240ms' }}>
            <ConfigSection
              title="Security Profile"
              icon={Shield}
              data={{ profile: config.profile }}
            />
          </div>
          <div className="animate-fade-in-up" style={{ animationDelay: '320ms' }}>
            <ConfigSection
              title="Providers"
              icon={Key}
              data={
                config.providers as Record<string, unknown> | undefined
              }
            />
          </div>
          <div className="animate-fade-in-up" style={{ animationDelay: '400ms' }}>
            <ConfigSection
              title="Sandbox"
              icon={Terminal}
              data={
                config.sandbox as Record<string, unknown> | undefined
              }
            />
          </div>
          <div className="animate-fade-in-up" style={{ animationDelay: '480ms' }}>
            <ConfigSection
              title="Scheduler"
              icon={Clock}
              data={
                config.scheduler as Record<string, unknown> | undefined
              }
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

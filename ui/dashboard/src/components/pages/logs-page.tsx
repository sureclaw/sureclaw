import { useState, useCallback } from 'react';
import {
  FileText,
  Search,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  ShieldAlert,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../hooks/use-api';
import type { AuditEntry, AuditParams } from '../../lib/types';

const ACTION_TYPES = [
  { value: '', label: 'All Actions' },
  { value: 'tool_call', label: 'Tool Calls' },
  { value: 'llm_request', label: 'LLM Requests' },
  { value: 'agent_spawn', label: 'Agent Spawn' },
  { value: 'agent_kill', label: 'Agent Kill' },
  { value: 'scan', label: 'Security Scans' },
  { value: 'file_read', label: 'File Read' },
  { value: 'file_write', label: 'File Write' },
  { value: 'ipc', label: 'IPC' },
];

const RESULT_TYPES = [
  { value: '', label: 'All Results' },
  { value: 'ok', label: 'OK' },
  { value: 'error', label: 'Error' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'timeout', label: 'Timeout' },
];

function ResultBadge({ result }: { result: string }) {
  switch (result) {
    case 'ok':
      return (
        <span className="badge-green">
          <CheckCircle size={12} />
          ok
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
          <ShieldAlert size={12} />
          blocked
        </span>
      );
    case 'timeout':
      return (
        <span className="badge-yellow">
          <Clock size={12} />
          timeout
        </span>
      );
    default:
      return <span className="badge-zinc">{result}</span>;
  }
}

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString();
}

export default function LogsPage() {
  const [action, setAction] = useState('');
  const [result, setResult] = useState('');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(50);

  const buildParams = useCallback((): AuditParams => {
    const params: AuditParams = { limit };
    if (action) params.action = action;
    if (result) params.result = result;
    if (search.trim()) params.search = search.trim();
    return params;
  }, [action, result, search, limit]);

  const {
    data: entries,
    loading,
    error,
    refresh,
  } = useApi<AuditEntry[]>(() => api.audit(buildParams()), [
    action,
    result,
    search,
    limit,
  ]);

  const handleLoadMore = () => {
    setLimit((prev) => prev + 50);
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle size={40} className="text-rose mb-4" />
        <h2 className="text-lg font-semibold text-foreground mb-2">
          Failed to load audit logs
        </h2>
        <p className="text-[13px] text-muted-foreground mb-4">{error.message}</p>
        <button onClick={refresh} className="btn-primary">
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
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Audit Logs</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            System activity and event history
          </p>
        </div>
        <button
          onClick={refresh}
          className="btn-secondary flex items-center gap-2 text-[13px]"
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {/* Filter bar */}
      <div className="card animate-fade-in-up" style={{ animationDelay: '80ms' }}>
        <div className="p-4">
          <div className="flex flex-wrap gap-3">
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="select text-[13px]"
            >
              {ACTION_TYPES.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>

            <select
              value={result}
              onChange={(e) => setResult(e.target.value)}
              className="select text-[13px]"
            >
              {RESULT_TYPES.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>

            <div className="relative flex-1 min-w-[200px]">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search actions, sessions..."
                className="input w-full pl-9 text-[13px]"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Logs table */}
      <div className="card animate-fade-in-up" style={{ animationDelay: '160ms' }}>
        <div className="card-header flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText size={16} className="text-amber" strokeWidth={1.8} />
            <h3 className="text-[14px] font-semibold tracking-tight text-foreground">
              Log Entries
            </h3>
          </div>
          {entries && (
            <span className="text-[11px] font-medium text-muted-foreground">
              {entries.length} entries
            </span>
          )}
        </div>
        <div className="overflow-x-auto">
          {loading && !entries ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="skeleton h-10 w-full" />
              ))}
            </div>
          ) : !entries || entries.length === 0 ? (
            <div className="text-center py-12 text-[13px] text-muted-foreground">
              {action || result || search
                ? 'No entries match your filters'
                : 'No audit entries recorded yet'}
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border/50 text-left">
                  <th className="px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Timestamp
                  </th>
                  <th className="px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Action
                  </th>
                  <th className="px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Session
                  </th>
                  <th className="px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Result
                  </th>
                  <th className="px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wide text-right">
                    Duration
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {entries.map((entry, i) => (
                  <tr
                    key={`${entry.timestamp}-${i}`}
                    className="hover:bg-foreground/[0.02] transition-colors"
                  >
                    <td className="px-6 py-3 text-muted-foreground whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <Clock size={12} className="text-muted-foreground/50" />
                        {formatTimestamp(entry.timestamp)}
                      </div>
                    </td>
                    <td className="px-6 py-3">
                      <span className="font-mono text-foreground/70">
                        {entry.action}
                      </span>
                    </td>
                    <td className="px-6 py-3">
                      <span className="font-mono text-[11px] text-muted-foreground/50">
                        {entry.sessionId.slice(0, 12)}...
                      </span>
                    </td>
                    <td className="px-6 py-3">
                      <ResultBadge result={entry.result} />
                    </td>
                    <td className="px-6 py-3 text-right text-muted-foreground tabular-nums">
                      {entry.durationMs}ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Load more */}
        {entries && entries.length >= limit && (
          <div className="p-4 border-t border-border/30 text-center">
            <button
              onClick={handleLoadMore}
              disabled={loading}
              className="btn-secondary text-[13px]"
            >
              {loading ? 'Loading...' : 'Load More'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

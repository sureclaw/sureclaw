import { useState, useCallback, useRef, useEffect } from 'react';
import {
  Users,
  RefreshCw,
  AlertTriangle,
  Terminal,
  Clock,
  XCircle,
  CheckCircle,
  FileText,
  FolderOpen,
  Brain,
  Activity,
  User,
  Globe,
  Trash2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../hooks/use-api';
import type {
  Agent,
  DocumentEntry,
  WorkspaceFileEntry,
  MemoryEntryView,
  McpServer,
} from '../../lib/types';

// ── Types ──

type SectionId = 'overview' | 'identity' | 'connectors' | 'workspace' | 'memory';

// ── Helpers ──

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

function formatDate(ts: string): string {
  return new Date(ts).toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '--';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Shared helpers ──

function TabSkeleton() {
  return (
    <div className="space-y-2">
      {[1, 2, 3].map((i) => (
        <div key={i} className="skeleton h-10 w-full" />
      ))}
    </div>
  );
}

function TabError({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-rose/5 border border-rose/15">
      <AlertTriangle size={14} className="text-rose shrink-0" />
      <p className="text-[12px] text-rose">{message}</p>
    </div>
  );
}

function TabEmpty({ label }: { label: string }) {
  return (
    <div className="text-center py-8 text-[13px] text-muted-foreground">{label}</div>
  );
}

// ── Agent Selector Dropdown ──

function AgentSelector({
  agents,
  selectedId,
  onSelect,
  onKill,
}: {
  agents: Agent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onKill: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selected = agents.find((a) => a.id === selectedId);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      {/* Selector bar */}
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between bg-card/80 border border-border/40 rounded-lg backdrop-blur-sm px-2.5 py-1.5 text-left transition-colors hover:bg-foreground/[0.02]"
      >
        {selected ? (
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={`w-2 h-2 rounded-full shrink-0 ${
                selected.status === 'running'
                  ? 'bg-emerald animate-pulse-live'
                  : 'bg-muted-foreground/50'
              }`}
            />
            <span className="font-medium text-[13px] text-foreground truncate">
              {selected.name}
            </span>
          </div>
        ) : (
          <span className="text-[13px] text-muted-foreground">Select an agent...</span>
        )}
        <ChevronDown
          size={14}
          strokeWidth={1.8}
          className={`text-muted-foreground shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-10 left-0 min-w-full w-max bg-card border border-border/40 rounded-xl mt-1 shadow-lg overflow-hidden">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className={`flex items-center justify-between px-4 py-2.5 cursor-pointer transition-colors ${
                agent.id === selectedId
                  ? 'bg-amber/5'
                  : 'hover:bg-foreground/[0.03]'
              }`}
            >
              <div
                className="flex items-center gap-2.5 min-w-0 flex-1"
                onClick={() => {
                  onSelect(agent.id);
                  setOpen(false);
                }}
              >
                <div
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    agent.status === 'running'
                      ? 'bg-emerald animate-pulse-live'
                      : 'bg-muted-foreground/50'
                  }`}
                />
                <span className="text-[13px] font-medium text-foreground truncate">
                  {agent.name}
                </span>
              </div>
              {(agent.status === 'running' || agent.status === 'idle') && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onKill(agent.id);
                  }}
                  className="btn-danger text-[11px] px-2 py-0.5 shrink-0 ml-2"
                >
                  Kill
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Vertical Sub-Nav ──

const NAV_GROUPS: {
  label: string;
  items: { id: SectionId; label: string; icon: typeof Activity }[];
}[] = [
  {
    label: 'AGENT',
    items: [
      { id: 'overview', label: 'Overview', icon: Activity },
      { id: 'identity', label: 'Identity', icon: User },
    ],
  },
  {
    label: 'TOOLS',
    items: [
      { id: 'connectors', label: 'Connectors', icon: Globe },
    ],
  },
  {
    label: 'DATA',
    items: [
      { id: 'workspace', label: 'Workspace', icon: FolderOpen },
      { id: 'memory', label: 'Memory', icon: Brain },
    ],
  },
];

function SubNav({
  activeSection,
  onSelect,
  agents,
  selectedId,
  onSelectAgent,
  onKill,
}: {
  activeSection: SectionId;
  onSelect: (id: SectionId) => void;
  agents: Agent[];
  selectedId: string | null;
  onSelectAgent: (id: string) => void;
  onKill: (id: string) => void;
}) {
  return (
    <div className="w-[180px] shrink-0 border-r border-border/30">
      {/* Agent selector above nav groups */}
      <div className="px-3 pt-3 pb-2">
        <AgentSelector
          agents={agents}
          selectedId={selectedId}
          onSelect={onSelectAgent}
          onKill={onKill}
        />
      </div>
      <div className="mx-3 h-px bg-border/30" />

      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground px-3 pt-4 pb-1 font-medium">
            {group.label}
          </p>
          {group.items.map((item) => {
            const Icon = item.icon;
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelect(item.id)}
                className={`flex items-center gap-2 w-full px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors ${
                  isActive
                    ? 'text-amber bg-amber/5 border-l-2 border-amber'
                    : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.03]'
                }`}
              >
                <Icon size={14} strokeWidth={1.8} />
                {item.label}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── Section Content Components ──

function InfoTab({
  agent,
  killed,
  killing,
  killError,
  onKill,
  onArchive,
}: {
  agent: Agent;
  killed: boolean;
  killing: boolean;
  killError: string;
  onKill: () => void;
  onArchive: () => void;
}) {
  return (
    <div className="space-y-4">
      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-muted-foreground text-[10px] uppercase tracking-wide font-medium mb-0.5">
            ID
          </p>
          <p className="text-foreground/70 font-mono text-[11px] break-all">
            {agent.id}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground text-[10px] uppercase tracking-wide font-medium mb-0.5">
            Type
          </p>
          <p className="text-foreground/70 text-[13px]">{agent.agentType}</p>
        </div>
        <div>
          <p className="text-muted-foreground text-[10px] uppercase tracking-wide font-medium mb-0.5">
            Created By
          </p>
          <p className="text-foreground/70 text-[13px]">{agent.createdBy}</p>
        </div>
        <div>
          <p className="text-muted-foreground text-[10px] uppercase tracking-wide font-medium mb-0.5">
            Created At
          </p>
          <p className="text-foreground/70 text-[13px]">{formatDate(agent.createdAt)}</p>
        </div>
        <div>
          <p className="text-muted-foreground text-[10px] uppercase tracking-wide font-medium mb-0.5">
            Updated At
          </p>
          <p className="text-foreground/70 text-[13px]">{formatDate(agent.updatedAt)}</p>
        </div>
        {agent.parentId && (
          <div>
            <p className="text-muted-foreground text-[10px] uppercase tracking-wide font-medium mb-0.5">
              Parent ID
            </p>
            <p className="text-foreground/70 font-mono text-[11px] break-all">
              {agent.parentId}
            </p>
          </div>
        )}
      </div>

      {/* Capabilities */}
      {agent.capabilities.length > 0 && (
        <div>
          <p className="text-muted-foreground text-[10px] uppercase tracking-wide font-medium mb-1.5">
            Capabilities
          </p>
          <div className="flex flex-wrap gap-1.5">
            {agent.capabilities.map((cap) => (
              <span key={cap} className="badge-zinc">
                {cap}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Children */}
      {agent.children && agent.children.length > 0 && (
        <div>
          <p className="text-muted-foreground text-[10px] uppercase tracking-wide font-medium mb-1.5">
            Child Agents ({agent.children.length})
          </p>
          <div className="space-y-1.5">
            {agent.children.map((child) => (
              <div
                key={child.id}
                className="flex items-center justify-between p-2 rounded-lg border border-border/30 bg-foreground/[0.02] text-[13px]"
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`w-1.5 h-1.5 rounded-full ${
                      child.status === 'running'
                        ? 'bg-emerald animate-pulse-live'
                        : 'bg-muted-foreground/50'
                    }`}
                  />
                  <span className="text-foreground/70">{child.name}</span>
                </div>
                <StatusBadge status={child.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Kill button */}
      {(agent.status === 'running' || agent.status === 'idle') && !killed && (
        <div className="pt-2 border-t border-border/30">
          {killError && (
            <div className="flex items-center gap-2 p-2 mb-3 rounded-lg bg-rose/5 border border-rose/15">
              <AlertTriangle size={14} className="text-rose shrink-0" />
              <p className="text-[13px] text-rose">{killError}</p>
            </div>
          )}
          <button
            onClick={onKill}
            disabled={killing}
            className="btn-danger w-full flex items-center justify-center gap-2 text-[13px]"
          >
            {killing ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Killing...
              </>
            ) : (
              <>
                <XCircle size={14} />
                Kill Agent
              </>
            )}
          </button>
        </div>
      )}

      {killed && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald/5 border border-emerald/15">
          <CheckCircle size={14} className="text-emerald shrink-0" />
          <p className="text-[13px] text-emerald">
            Agent killed successfully. Refresh to update the list.
          </p>
        </div>
      )}

      {/* Delete (archive) */}
      <div className="pt-2 border-t border-border/30">
        <button
          onClick={() => {
            if (confirm(`Delete agent "${agent.name}"? The agent will be archived and hidden from the list.`)) {
              onArchive();
            }
          }}
          className="flex items-center gap-2 text-[13px] text-muted-foreground/60 hover:text-rose transition-colors"
        >
          <Trash2 size={14} />
          Delete agent
        </button>
      </div>
    </div>
  );
}

function IdentityTab({ agentId }: { agentId: string }) {
  const { data: docs, loading, error } = useApi<DocumentEntry[]>(
    () => api.agentIdentity(agentId),
    [agentId]
  );
  const [expanded, setExpanded] = useState<string | null>(null);

  if (loading) return <TabSkeleton />;
  if (error) return <TabError message={error.message} />;
  if (!docs || docs.length === 0) return <TabEmpty label="No identity files" />;

  return (
    <div className="space-y-2">
      {docs.map((doc) => (
        <div key={doc.key} className="rounded-lg border border-border/30 overflow-hidden">
          <button
            onClick={() => setExpanded(expanded === doc.key ? null : doc.key)}
            className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-foreground/[0.02] transition-colors"
          >
            <div className="flex items-center gap-2">
              <FileText size={12} className="text-amber shrink-0" />
              <span className="text-[13px] font-medium text-foreground">{doc.key}</span>
            </div>
            {expanded === doc.key ? (
              <ChevronUp size={12} className="text-muted-foreground" />
            ) : (
              <ChevronDown size={12} className="text-muted-foreground" />
            )}
          </button>
          {expanded === doc.key && (
            <div className="px-3 pb-3 border-t border-border/20">
              <pre className="text-[11px] text-foreground/70 font-mono whitespace-pre-wrap mt-2 max-h-[300px] overflow-y-auto">
                {doc.content}
              </pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function WorkspaceTab({ agentId }: { agentId: string }) {
  const { data: files, loading, error } = useApi<WorkspaceFileEntry[]>(
    () => api.agentWorkspace(agentId),
    [agentId]
  );

  if (loading) return <TabSkeleton />;
  if (error) return <TabError message={error.message} />;
  if (!files || files.length === 0) return <TabEmpty label="No workspace files" />;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-1 pb-2">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
          Agent workspace
        </p>
        <span className="text-[10px] text-muted-foreground">{files.length} files</span>
      </div>
      {files.map((file) => (
        <div
          key={file.path}
          className="flex items-center justify-between px-3 py-1.5 rounded-lg hover:bg-foreground/[0.02] transition-colors"
        >
          <div className="flex items-center gap-2 min-w-0">
            <FileText size={12} className="text-sky shrink-0" />
            <span className="text-[12px] font-mono text-foreground/70 truncate">{file.path}</span>
          </div>
          <span className="text-[10px] text-muted-foreground shrink-0 ml-2">
            {formatBytes(file.size)}
          </span>
        </div>
      ))}
    </div>
  );
}

function MemoryTab({ agentId }: { agentId: string }) {
  const [scope, setScope] = useState('general');
  const { data: entries, loading, error } = useApi<MemoryEntryView[]>(
    () => api.agentMemory(agentId, scope, 50),
    [agentId, scope]
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
          Scope
        </label>
        <input
          type="text"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="input text-[12px] px-2 py-1 w-28"
          placeholder="general"
        />
      </div>

      {loading && <TabSkeleton />}
      {error && <TabError message={error.message} />}
      {!loading && !error && (!entries || entries.length === 0) && (
        <TabEmpty label="No memory entries" />
      )}

      {entries && entries.length > 0 && (
        <div className="space-y-2">
          {entries.map((entry, i) => (
            <div
              key={entry.id ?? i}
              className="p-3 rounded-lg border border-border/30 bg-foreground/[0.02]"
            >
              <p className="text-[12px] text-foreground/80 whitespace-pre-wrap break-words">
                {entry.content}
              </p>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                {entry.tags &&
                  entry.tags.map((tag) => (
                    <span key={tag} className="badge-zinc text-[9px]">
                      {tag}
                    </span>
                  ))}
                {entry.createdAt && (
                  <span className="text-[10px] text-muted-foreground">
                    {formatDate(entry.createdAt)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Agent Connectors Section ──

function ConnectorsSection({ agentId }: { agentId: string }) {
  const { data: allServers, loading: loadingServers, error: serversError } = useApi<McpServer[]>(
    () => api.mcpServers(),
    []
  );
  const { data: assignedNames, loading: loadingAssigned, error: assignedError, refresh } = useApi<string[]>(
    () => api.agentMcpServers(agentId),
    [agentId]
  );

  const [toggling, setToggling] = useState<string | null>(null);

  const loading = loadingServers || loadingAssigned;
  const error = serversError || assignedError;

  const handleToggle = async (serverName: string, assigned: boolean) => {
    setToggling(serverName);
    try {
      if (assigned) {
        await api.unassignMcpServer(agentId, serverName);
      } else {
        await api.assignMcpServer(agentId, serverName);
      }
      refresh();
    } catch {
      // refresh will show current state
      refresh();
    } finally {
      setToggling(null);
    }
  };

  if (loading) return <TabSkeleton />;
  if (error) return <TabError message={error.message} />;
  if (!allServers || allServers.length === 0) {
    return (
      <div className="text-center py-12">
        <Globe size={32} className="text-muted-foreground/30 mx-auto mb-3" />
        <p className="text-[13px] text-muted-foreground mb-1">No MCP servers configured</p>
        <p className="text-[11px] text-muted-foreground">
          Add servers from the Connectors page first.
        </p>
      </div>
    );
  }

  const assignedSet = new Set(assignedNames ?? []);

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-[14px] font-semibold text-foreground">Connectors</h4>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Toggle which MCP servers this agent can access.
        </p>
      </div>

      <div className="space-y-1.5">
        {allServers.map((server) => {
          const assigned = assignedSet.has(server.name);
          const isToggling = toggling === server.name;

          return (
            <div
              key={server.name}
              className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border/30 hover:bg-foreground/[0.02] transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    assigned ? 'bg-emerald' : 'bg-muted-foreground/30'
                  }`}
                />
                <div className="min-w-0">
                  <span className="text-[13px] font-medium text-foreground block truncate">
                    {server.name}
                  </span>
                  <span className="text-[11px] font-mono text-muted-foreground block truncate">
                    {server.url}
                  </span>
                </div>
              </div>

              <button
                onClick={() => handleToggle(server.name, assigned)}
                disabled={isToggling}
                className={`shrink-0 ml-3 relative w-9 h-5 rounded-full transition-colors ${
                  assigned ? 'bg-emerald' : 'bg-muted-foreground/20'
                } ${isToggling ? 'opacity-50' : ''}`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                    assigned ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Content Area ──

function ContentArea({
  agent,
  activeSection,
  onArchive,
}: {
  agent: Agent;
  activeSection: SectionId;
  onArchive: (id: string) => void;
}) {
  const [killing, setKilling] = useState(false);
  const [killError, setKillError] = useState('');
  const [killed, setKilled] = useState(false);

  const handleKill = async () => {
    setKilling(true);
    setKillError('');
    try {
      await api.killAgent(agent.id);
      setKilled(true);
    } catch (err) {
      setKillError(err instanceof Error ? err.message : 'Kill failed');
    } finally {
      setKilling(false);
    }
  };

  return (
    <div className="flex-1 min-w-0 pl-6">
      <div className="bg-card/80 border border-border/40 rounded-xl backdrop-blur-sm shadow-sm overflow-hidden">
        <div className="px-6 py-4 overflow-x-auto">
          {activeSection === 'overview' && (
            <InfoTab
              agent={agent}
              killed={killed}
              killing={killing}
              killError={killError}
              onKill={handleKill}
              onArchive={() => onArchive(agent.id)}
            />
          )}
          {activeSection === 'identity' && <IdentityTab agentId={agent.id} />}
          {activeSection === 'connectors' && <ConnectorsSection agentId={agent.id} />}
          {activeSection === 'workspace' && <WorkspaceTab agentId={agent.id} />}
          {activeSection === 'memory' && <MemoryTab agentId={agent.id} />}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──

export default function AgentsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>('overview');

  const {
    data: agents,
    loading,
    error,
    refresh,
  } = useApi<Agent[]>(() => api.agents(), []);

  // Auto-select first agent when list loads and nothing selected
  useEffect(() => {
    if (agents && agents.length > 0 && !selectedId) {
      setSelectedId(agents[0].id);
    }
  }, [agents, selectedId]);

  const handleKill = useCallback(
    (id: string) => {
      api.killAgent(id).then(() => {
        setTimeout(refresh, 500);
      });
    },
    [refresh]
  );

  const handleArchive = useCallback(
    (id: string) => {
      api.archiveAgent(id).then(() => {
        if (selectedId === id) setSelectedId(null);
        refresh();
      });
    },
    [refresh, selectedId]
  );

  const selectedAgent = agents?.find((a) => a.id === selectedId);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle size={40} className="text-rose mb-4" />
        <h2 className="text-lg font-semibold text-foreground mb-2">
          Failed to load agents
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
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-end justify-between animate-fade-in-up">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Agents</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Manage and monitor running agents
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

      {/* Loading state */}
      {loading && !agents && (
        <div className="animate-fade-in-up" style={{ animationDelay: '80ms' }}>
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-12 w-full" />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && (!agents || agents.length === 0) && (
        <div className="animate-fade-in-up" style={{ animationDelay: '80ms' }}>
          <div className="bg-card/80 border border-border/40 rounded-xl backdrop-blur-sm shadow-sm">
            <div className="text-center py-12">
              <Users size={32} className="text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-[13px] text-muted-foreground">No agents registered</p>
            </div>
          </div>
        </div>
      )}

      {/* Sub-nav + Content */}
      {agents && agents.length > 0 && (
        <div
          className="flex gap-0 min-w-0 animate-fade-in-up"
          style={{ animationDelay: '80ms' }}
        >
          <SubNav
            activeSection={activeSection}
            onSelect={setActiveSection}
            agents={agents}
            selectedId={selectedId}
            onSelectAgent={setSelectedId}
            onKill={handleKill}
          />
          {selectedAgent ? (
            <ContentArea agent={selectedAgent} activeSection={activeSection} onArchive={handleArchive} />
          ) : (
            <div className="flex-1 min-w-0 pl-6">
              <div className="bg-card/80 border border-border/40 rounded-xl backdrop-blur-sm shadow-sm">
                <div className="text-center py-12">
                  <Users size={32} className="text-muted-foreground/30 mx-auto mb-3" />
                  <p className="text-[13px] text-muted-foreground">Select an agent to view details</p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

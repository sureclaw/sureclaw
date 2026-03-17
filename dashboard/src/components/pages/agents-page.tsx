import { useState, useCallback } from 'react';
import {
  Users,
  RefreshCw,
  AlertTriangle,
  ChevronRight,
  Terminal,
  Clock,
  XCircle,
  CheckCircle,
  FileText,
  Sparkles,
  FolderOpen,
  Brain,
  Info,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../hooks/use-api';
import type {
  Agent,
  DocumentEntry,
  SkillEntry,
  WorkspaceFileEntry,
  MemoryEntryView,
} from '../../lib/types';

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

type TabId = 'info' | 'identity' | 'skills' | 'workspace' | 'memory';

const TABS: { id: TabId; label: string; icon: typeof Info }[] = [
  { id: 'info', label: 'Info', icon: Info },
  { id: 'identity', label: 'Identity', icon: FileText },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'workspace', label: 'Workspace', icon: FolderOpen },
  { id: 'memory', label: 'Memory', icon: Brain },
];

// ── Tab Content Components ──

function InfoTab({
  agent,
  killed,
  killing,
  killError,
  onKill,
}: {
  agent: Agent;
  killed: boolean;
  killing: boolean;
  killError: string;
  onKill: () => void;
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

function SkillsTab({ agentId }: { agentId: string }) {
  const { data: skills, loading, error } = useApi<SkillEntry[]>(
    () => api.agentSkills(agentId),
    [agentId]
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [skillContent, setSkillContent] = useState<Record<string, string>>({});
  const [loadingSkill, setLoadingSkill] = useState<string | null>(null);

  const toggleSkill = async (name: string) => {
    if (expanded === name) {
      setExpanded(null);
      return;
    }
    setExpanded(name);
    if (!skillContent[name]) {
      setLoadingSkill(name);
      try {
        const result = await api.agentSkillContent(agentId, name);
        setSkillContent((prev) => ({ ...prev, [name]: result.content }));
      } catch {
        setSkillContent((prev) => ({ ...prev, [name]: '(failed to load)' }));
      } finally {
        setLoadingSkill(null);
      }
    }
  };

  if (loading) return <TabSkeleton />;
  if (error) return <TabError message={error.message} />;
  if (!skills || skills.length === 0) return <TabEmpty label="No skills" />;

  return (
    <div className="space-y-2">
      {skills.map((skill) => (
        <div key={skill.name} className="rounded-lg border border-border/30 overflow-hidden">
          <button
            onClick={() => toggleSkill(skill.name)}
            className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-foreground/[0.02] transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <Sparkles size={12} className="text-violet shrink-0" />
              <span className="text-[13px] font-medium text-foreground truncate">{skill.name}</span>
            </div>
            {expanded === skill.name ? (
              <ChevronUp size={12} className="text-muted-foreground shrink-0" />
            ) : (
              <ChevronDown size={12} className="text-muted-foreground shrink-0" />
            )}
          </button>
          {skill.description && expanded !== skill.name && (
            <p className="px-3 pb-2 text-[11px] text-muted-foreground truncate">{skill.description}</p>
          )}
          {expanded === skill.name && (
            <div className="px-3 pb-3 border-t border-border/20">
              {loadingSkill === skill.name ? (
                <div className="skeleton h-20 w-full mt-2" />
              ) : (
                <pre className="text-[11px] text-foreground/70 font-mono whitespace-pre-wrap mt-2 max-h-[300px] overflow-y-auto">
                  {skillContent[skill.name] ?? ''}
                </pre>
              )}
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

// ── Agent Detail Panel ──

function AgentDetail({
  agent,
  onClose,
  onKill,
}: {
  agent: Agent;
  onClose: () => void;
  onKill: (id: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<TabId>('info');
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
    <div className="card">
      {/* Header */}
      <div className="card-header flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <Terminal size={14} className="text-amber shrink-0" />
          <h3 className="text-[14px] font-semibold tracking-tight text-foreground truncate">
            {agent.name}
          </h3>
          <StatusBadge status={killed ? 'stopped' : agent.status} />
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          <XCircle size={16} />
        </button>
      </div>

      {agent.description && (
        <p className="px-6 pt-2 text-[12px] text-muted-foreground">{agent.description}</p>
      )}

      {/* Tab bar */}
      <div className="border-b border-border/30 px-4 pt-2">
        <div className="flex gap-0.5">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded-t-md transition-colors ${
                  isActive
                    ? 'text-amber border-b-2 border-amber bg-amber/5'
                    : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.03]'
                }`}
              >
                <Icon size={11} strokeWidth={1.8} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab content */}
      <div className="card-body">
        {activeTab === 'info' && (
          <InfoTab
            agent={agent}
            killed={killed}
            killing={killing}
            killError={killError}
            onKill={handleKill}
          />
        )}
        {activeTab === 'identity' && <IdentityTab agentId={agent.id} />}
        {activeTab === 'skills' && <SkillsTab agentId={agent.id} />}
        {activeTab === 'workspace' && <WorkspaceTab agentId={agent.id} />}
        {activeTab === 'memory' && <MemoryTab agentId={agent.id} />}
      </div>
    </div>
  );
}

// ── Main Page ──

export default function AgentsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const {
    data: agents,
    loading,
    error,
    refresh,
  } = useApi<Agent[]>(() => api.agents(), []);

  const handleKill = useCallback(
    (id: string) => {
      api.killAgent(id).then(() => {
        setTimeout(refresh, 500);
      });
    },
    [refresh]
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
    <div className="space-y-8">
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Agent list */}
        <div className="lg:col-span-2">
          <div className="card animate-fade-in-up" style={{ animationDelay: '80ms' }}>
            <div className="card-header flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users size={16} className="text-amber" strokeWidth={1.8} />
                <h3 className="text-[14px] font-semibold tracking-tight text-foreground">
                  All Agents
                </h3>
              </div>
              {agents && (
                <span className="text-[11px] font-medium text-muted-foreground">
                  {agents.length} total
                </span>
              )}
            </div>
            <div className="overflow-x-auto">
              {loading && !agents ? (
                <div className="p-4 space-y-3">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="skeleton h-12 w-full" />
                  ))}
                </div>
              ) : !agents || agents.length === 0 ? (
                <div className="text-center py-12 text-[13px] text-muted-foreground">
                  No agents registered
                </div>
              ) : (
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-border/50 text-left">
                      <th className="px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                        Name
                      </th>
                      <th className="px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                        Type
                      </th>
                      <th className="px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                        Status
                      </th>
                      <th className="px-6 py-3 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                        Created
                      </th>
                      <th className="px-6 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {agents.map((agent) => (
                      <tr
                        key={agent.id}
                        onClick={() => setSelectedId(agent.id)}
                        className={`cursor-pointer transition-colors ${
                          selectedId === agent.id
                            ? 'bg-foreground/[0.04]'
                            : 'hover:bg-foreground/[0.02]'
                        }`}
                      >
                        <td className="px-6 py-3">
                          <div className="flex items-center gap-2">
                            <div
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                agent.status === 'running'
                                  ? 'bg-emerald animate-pulse-live'
                                  : agent.status === 'error'
                                    ? 'bg-rose'
                                    : 'bg-muted-foreground/50'
                              }`}
                            />
                            <span className="font-medium text-foreground">
                              {agent.name}
                            </span>
                          </div>
                        </td>
                        <td className="px-6 py-3 text-muted-foreground">
                          {agent.agentType}
                        </td>
                        <td className="px-6 py-3">
                          <StatusBadge status={agent.status} />
                        </td>
                        <td className="px-6 py-3 text-muted-foreground">
                          <div className="flex items-center gap-1.5">
                            <Clock size={12} className="text-muted-foreground/50" />
                            {formatDate(agent.createdAt)}
                          </div>
                        </td>
                        <td className="px-6 py-3">
                          <ChevronRight
                            size={14}
                            className="text-muted-foreground/30"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        {/* Detail panel */}
        <div className="animate-fade-in-up" style={{ animationDelay: '160ms' }}>
          {selectedAgent ? (
            <AgentDetail
              agent={selectedAgent}
              onClose={() => setSelectedId(null)}
              onKill={handleKill}
            />
          ) : (
            <div className="card">
              <div className="card-body text-center py-12">
                <Users size={32} className="text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-[13px] text-muted-foreground">
                  Select an agent to view details
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

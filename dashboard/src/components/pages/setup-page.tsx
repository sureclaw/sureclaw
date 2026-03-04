import { useState, type FormEvent } from 'react';
import {
  Shield,
  ChevronRight,
  Key,
  Terminal,
  CheckCircle,
  AlertTriangle,
  Eye,
  Activity,
  Zap,
  Hexagon,
} from 'lucide-react';
import { apiFetch, setToken } from '../../lib/api';
import type { SetupResponse } from '../../lib/types';

type Step = 'welcome' | 'profile' | 'agent-type' | 'api-key' | 'review' | 'done';

const STEPS: Step[] = ['welcome', 'profile', 'agent-type', 'api-key', 'review', 'done'];

interface SetupPageProps {
  onComplete: () => void;
}

const PROFILES = [
  {
    id: 'paranoid',
    label: 'Paranoid',
    icon: Shield,
    color: 'border-rose/30 hover:border-rose/50',
    selectedColor: 'border-rose bg-rose/5',
    iconColor: 'text-rose',
    description:
      'Maximum security. No network access for agents. All content is taint-tagged. Every operation is audited and scrutinized. Recommended for production.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    icon: Eye,
    color: 'border-amber/30 hover:border-amber/50',
    selectedColor: 'border-amber bg-amber/5',
    iconColor: 'text-amber',
    description:
      'Reasonable defaults. Network restricted to allowlisted domains. Content tainting enabled for external sources. Good for most use cases.',
  },
  {
    id: 'yolo',
    label: 'YOLO',
    icon: Zap,
    color: 'border-emerald/30 hover:border-emerald/50',
    selectedColor: 'border-emerald bg-emerald/5',
    iconColor: 'text-emerald',
    description:
      'Minimal restrictions. Agents can access the network freely. Use only in trusted, isolated development environments. Not recommended for production.',
  },
];

const AGENT_TYPES = [
  {
    id: 'pi-session',
    label: 'PI Session',
    icon: Terminal,
    description: 'General-purpose AI agent with tool access and sandboxing.',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    icon: Activity,
    description:
      'Code-focused agent powered by Claude with file system and terminal tools.',
  },
];

function StepIndicator({ current, steps }: { current: Step; steps: Step[] }) {
  const currentIndex = steps.indexOf(current);
  return (
    <div className="flex items-center gap-1.5">
      {steps.map((step, i) => (
        <div
          key={step}
          className={`h-1.5 rounded-full transition-all duration-300 ${
            i <= currentIndex
              ? 'bg-amber w-8'
              : 'bg-foreground/[0.06] w-4'
          }`}
        />
      ))}
    </div>
  );
}

export default function SetupPage({ onComplete }: SetupPageProps) {
  const [step, setStep] = useState<Step>('welcome');
  const [profile, setProfile] = useState('balanced');
  const [agentType, setAgentType] = useState('pi-session');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const stepIndex = STEPS.indexOf(step);

  const goNext = () => {
    const nextIndex = stepIndex + 1;
    if (nextIndex < STEPS.length) {
      setStep(STEPS[nextIndex]);
      setError('');
    }
  };

  const goBack = () => {
    const prevIndex = stepIndex - 1;
    if (prevIndex >= 0) {
      setStep(STEPS[prevIndex]);
      setError('');
    }
  };

  const handleConfigure = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const result = await apiFetch<SetupResponse>('/setup/configure', {
        method: 'POST',
        body: JSON.stringify({
          profile,
          agentType,
          apiKey: apiKey.trim(),
        }),
      });

      setToken(result.token);
      setStep('done');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Configuration failed'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-lg animate-fade-in-up">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-foreground/[0.04] border border-border/50 mb-4">
            <Hexagon className="h-7 w-7 text-amber" strokeWidth={1.8} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">AX Setup</h1>
          <p className="text-[13px] text-muted-foreground mt-1">
            Configure your AX instance
          </p>
          <div className="mt-4 flex justify-center">
            <StepIndicator current={step} steps={STEPS} />
          </div>
        </div>

        {/* Step content */}
        <div className="card">
          <div className="p-6">
            {/* Welcome */}
            {step === 'welcome' && (
              <div className="text-center space-y-4">
                <Shield size={40} className="text-amber mx-auto" strokeWidth={1.5} />
                <h2 className="text-lg font-semibold text-foreground">
                  Welcome to AX
                </h2>
                <p className="text-[13px] text-muted-foreground leading-relaxed">
                  AX is a security-focused AI agent platform. We are going to walk you through a few configuration steps to get things running. We will set up your security profile, choose an agent type, and configure API access.
                </p>
                <p className="text-[11px] text-muted-foreground/50">
                  This should take about a minute.
                </p>
              </div>
            )}

            {/* Security Profile */}
            {step === 'profile' && (
              <div className="space-y-4">
                <div className="text-center mb-2">
                  <h2 className="text-lg font-semibold text-foreground">
                    Security Profile
                  </h2>
                  <p className="text-[13px] text-muted-foreground mt-1">
                    How paranoid should we be?
                  </p>
                </div>
                <div className="space-y-3">
                  {PROFILES.map((p) => {
                    const Icon = p.icon;
                    const isSelected = profile === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setProfile(p.id)}
                        className={`w-full text-left p-4 rounded-xl border-2 transition-all duration-200 ${
                          isSelected ? p.selectedColor : `${p.color} bg-transparent`
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="p-1.5 rounded-lg bg-foreground/[0.04] shrink-0 mt-0.5">
                            <Icon size={18} className={p.iconColor} strokeWidth={1.8} />
                          </div>
                          <div>
                            <p className="font-medium text-foreground">
                              {p.label}
                            </p>
                            <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">
                              {p.description}
                            </p>
                          </div>
                          {isSelected && (
                            <CheckCircle
                              size={18}
                              className="text-amber shrink-0 mt-0.5 ml-auto"
                            />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Agent Type */}
            {step === 'agent-type' && (
              <div className="space-y-4">
                <div className="text-center mb-2">
                  <h2 className="text-lg font-semibold text-foreground">
                    Agent Type
                  </h2>
                  <p className="text-[13px] text-muted-foreground mt-1">
                    Choose your default agent runner
                  </p>
                </div>
                <div className="space-y-3">
                  {AGENT_TYPES.map((at) => {
                    const Icon = at.icon;
                    const isSelected = agentType === at.id;
                    return (
                      <button
                        key={at.id}
                        type="button"
                        onClick={() => setAgentType(at.id)}
                        className={`w-full text-left p-4 rounded-xl border-2 transition-all duration-200 ${
                          isSelected
                            ? 'border-amber bg-amber/5'
                            : 'border-border hover:border-border/80 bg-transparent'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="p-1.5 rounded-lg bg-foreground/[0.04] shrink-0 mt-0.5">
                            <Icon size={18} className="text-amber" strokeWidth={1.8} />
                          </div>
                          <div>
                            <p className="font-medium text-foreground">
                              {at.label}
                            </p>
                            <p className="text-[12px] text-muted-foreground mt-1">
                              {at.description}
                            </p>
                          </div>
                          {isSelected && (
                            <CheckCircle
                              size={18}
                              className="text-amber shrink-0 mt-0.5 ml-auto"
                            />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* API Key */}
            {step === 'api-key' && (
              <div className="space-y-4">
                <div className="text-center mb-2">
                  <h2 className="text-lg font-semibold text-foreground">
                    API Key
                  </h2>
                  <p className="text-[13px] text-muted-foreground mt-1">
                    Enter your LLM provider API key
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="api-key"
                    className="block text-[13px] font-medium text-foreground/80 mb-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <Key size={14} />
                      API Key
                    </div>
                  </label>
                  <input
                    id="api-key"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-..."
                    className="input w-full"
                    autoFocus
                  />
                  <p className="text-[11px] text-muted-foreground/50 mt-2">
                    This key is stored securely on the server and never exposed to
                    agent sandboxes.
                  </p>
                </div>
              </div>
            )}

            {/* Review */}
            {step === 'review' && (
              <form onSubmit={handleConfigure} className="space-y-4">
                <div className="text-center mb-2">
                  <h2 className="text-lg font-semibold text-foreground">
                    Review Configuration
                  </h2>
                  <p className="text-[13px] text-muted-foreground mt-1">
                    Confirm your settings before we start
                  </p>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between p-3 rounded-lg border border-border/30 bg-foreground/[0.02]">
                    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                      <Shield size={14} />
                      Security Profile
                    </div>
                    <span className="text-[13px] font-medium text-foreground capitalize">
                      {profile}
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-3 rounded-lg border border-border/30 bg-foreground/[0.02]">
                    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                      <Terminal size={14} />
                      Agent Type
                    </div>
                    <span className="text-[13px] font-medium text-foreground">
                      {AGENT_TYPES.find((at) => at.id === agentType)?.label}
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-3 rounded-lg border border-border/30 bg-foreground/[0.02]">
                    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                      <Key size={14} />
                      API Key
                    </div>
                    <span className="text-[13px] font-medium text-foreground font-mono">
                      {apiKey ? `${apiKey.slice(0, 7)}${'*'.repeat(8)}` : 'Not set'}
                    </span>
                  </div>
                </div>

                {error && (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-rose/5 border border-rose/15">
                    <AlertTriangle
                      size={16}
                      className="text-rose mt-0.5 shrink-0"
                    />
                    <p className="text-[13px] text-rose">{error}</p>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="btn-primary w-full flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin" />
                      Configuring...
                    </>
                  ) : (
                    <>
                      <CheckCircle size={16} />
                      Configure AX
                    </>
                  )}
                </button>
              </form>
            )}

            {/* Done */}
            {step === 'done' && (
              <div className="text-center space-y-4">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald/5 border border-emerald/15">
                  <CheckCircle size={32} className="text-emerald" />
                </div>
                <h2 className="text-lg font-semibold text-foreground">
                  All Set!
                </h2>
                <p className="text-[13px] text-muted-foreground">
                  AX is configured and ready to go. Your admin token has been
                  generated and saved.
                </p>
                <button
                  onClick={onComplete}
                  className="btn-primary flex items-center gap-2 mx-auto"
                >
                  Open Dashboard
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </div>

          {/* Navigation footer */}
          {step !== 'done' && step !== 'review' && (
            <div className="px-6 pb-6 flex items-center justify-between">
              {step === 'welcome' ? (
                <div />
              ) : (
                <button
                  onClick={goBack}
                  className="btn-secondary text-[13px]"
                >
                  Back
                </button>
              )}
              <button
                onClick={goNext}
                disabled={step === 'api-key' && !apiKey.trim()}
                className="btn-primary flex items-center gap-1.5 text-[13px]"
              >
                {step === 'welcome' ? 'Get Started' : 'Continue'}
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

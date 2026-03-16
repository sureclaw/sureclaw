# Infrastructure Journal

Infrastructure, deployment, Helm, k8s, FluxCD entries.

## Entries

- Merge agent-runtime into host + NATS auth: 2→3 pod architecture, capability tokens, static users [host-merge-nats-auth.md](host-merge-nats-auth.md)
- NATS static user auth: host (full) + sandbox (restricted) with auto-generated passwords [nats-auth.md](nats-auth.md)
- Host RBAC: ServiceAccount, Role, RoleBinding for sandbox pod management [host-rbac.md](host-rbac.md)
- Pool controller pod template update for NATS IPC [pool-controller-nats.md](pool-controller-nats.md)
- Cortex acceptance test fixes: FIX-6/7/8/9 [cortex-acceptance-fixes.md](cortex-acceptance-fixes.md)
- Helm presets + `ax k8s init` CLI wizard [k8s-presets-init.md](k8s-presets-init.md)
- Helm chart deployment improvements (5 fixes) [helm-deploy-fixes.md](helm-deploy-fixes.md)
- Helm chart + FluxCD GitOps implementation [helm-fluxcd.md](helm-fluxcd.md)
- Phase 3 k8s gaps: NATS LLM proxy + claude-code NATS bridge wiring [k8s-phase3-gaps.md](k8s-phase3-gaps.md)

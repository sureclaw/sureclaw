# Infrastructure Journal

Infrastructure, deployment, Helm, k8s, FluxCD entries.

## Entries

- Git-SSH workspace provider on kind: openssh-client in container, network policy for SSH, sshd config fix for K8s (no chroot) [git-ssh-workspace.md](git-ssh-workspace.md)
- PVC workspace config: configurable PVC size + aggressive pod idle timeout [pvc-workspace-config.md](pvc-workspace-config.md)
- K8s dev loop: extraVolumes in PodTemplate, Helm chart updates, kind-dev-values.yaml, k8s-dev.sh script [k8s-dev-loop.md](k8s-dev-loop.md)

- Runner IS the standby: remove sleep hack, runner.js subscribes to NATS for work [pool-controller-nats.md](pool-controller-nats.md)
- Warm sandbox pool claiming: claim pre-warmed pods via label patching + k8s Exec API [warm-pool-claiming.md](warm-pool-claiming.md)
- Merge agent-runtime into host + NATS auth: 2→3 pod architecture, capability tokens, static users [host-merge-nats-auth.md](host-merge-nats-auth.md)
- NATS static user auth: host (full) + sandbox (restricted) with auto-generated passwords [nats-auth.md](nats-auth.md)
- Host RBAC: ServiceAccount, Role, RoleBinding for sandbox pod management [host-rbac.md](host-rbac.md)
- Pool controller pod template update for NATS IPC [pool-controller-nats.md](pool-controller-nats.md)
- Cortex acceptance test fixes: FIX-6/7/8/9 [cortex-acceptance-fixes.md](cortex-acceptance-fixes.md)
- Helm presets + `ax k8s init` CLI wizard [k8s-presets-init.md](k8s-presets-init.md)
- Helm chart deployment improvements (5 fixes) [helm-deploy-fixes.md](helm-deploy-fixes.md)
- Helm chart + FluxCD GitOps implementation [helm-fluxcd.md](helm-fluxcd.md)
- K8s networking simplification: NATS queue groups + HTTP gateway [k8s-networking-simplification.md](k8s-networking-simplification.md)
- Phase 3 k8s gaps: NATS LLM proxy + claude-code NATS bridge wiring [k8s-phase3-gaps.md](k8s-phase3-gaps.md)
- Debug harness missing routes: LLM proxy, workspace release/staging [debug-harness-routes.md](debug-harness-routes.md)

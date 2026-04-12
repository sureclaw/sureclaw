## [2026-04-10 16:01] — Git-SSH workspace provider setup on kind cluster

**Task:** Enable git-ssh workspace provider on kind cluster for file persistence across sessions

**What I did:**
1. Added openssh-client to agent container Dockerfile (line 17)
2. Updated host network policy to allow SSH egress to git-server pod (port 22)
3. Mounted SSH private key secret to host pod from ax-agent-ssh secret
4. Fixed git-server sshd configuration to work in K8s:
   - Disabled ChrootDirectory (K8s doesn't allow CAP_SYS_CHROOT)
   - Created sshd_config.d/k8s.conf in entrypoint to override defaults
   - Ensured SSH key mount is readable (defaultMode 0o444)

**Files touched:**
- container/agent/Dockerfile (added openssh-client)
- charts/ax/templates/networkpolicies/host-network.yaml (added SSH egress rule)
- container/git-server/entrypoint.sh (disabled chroot, configured sshd)

**Outcome:** Partial success
- Infrastructure in place: SSH keys mounted, network policy allows SSH, container has SSH client
- Git-server sshd now listens without chroot errors
- Host pod can reach git-server (network connectivity works)
- SSH connection still failing with "connection reset" — likely sshd host key algorithm negotiation issue (client OpenSSH 9.2 vs server OpenSSH 10.2)

**Next steps:**
1. Debug SSH host key algorithm compatibility between client and server versions
2. Test git repo creation once SSH auth works
3. Verify workspace file persistence across concurrent sessions
4. Update Helm chart templates to include SSH key mounting for production deployments

.PHONY: build deploy help clean

# Configuration
REGISTRY ?= ghcr.io/project-ax
TAG ?= $(shell git rev-parse --short HEAD)
IMAGE ?= $(REGISTRY)/ax:$(TAG)
GIT_SERVER_IMAGE ?= $(REGISTRY)/ax-git-server:$(TAG)
KIND_CLUSTER ?= ax
NAMESPACE ?= ax
VALUES_FILE ?= ax-values.yaml

help:
	@echo "AX Build & Deploy"
	@echo ""
	@echo "Main Targets:"
	@echo "  make build              Compile code and build AX Docker image"
	@echo "  make deploy             Build AX, load into kind, and helm upgrade"
	@echo "  make deploy-all         Deploy both AX and git-server"
	@echo ""
	@echo "Git Server Targets:"
	@echo "  make build-git-server   Build git-server Docker image"
	@echo "  make deploy-git-server  Build git-server, load into kind, and helm upgrade"
	@echo ""
	@echo "Utility:"
	@echo "  make clean              Remove built images from local Docker"
	@echo "  make rebuild            Quick iteration (compile + build + helm upgrade)"
	@echo "  make status             Check pod status and image tags"
	@echo ""
	@echo "Variables (override with: make deploy TAG=abc123):"
	@echo "  TAG                     Image tag (default: git short SHA = $(TAG))"
	@echo "  REGISTRY                Docker registry (default: $(REGISTRY))"
	@echo "  KIND_CLUSTER            Kind cluster name (default: $(KIND_CLUSTER))"
	@echo "  NAMESPACE               Kubernetes namespace (default: $(NAMESPACE))"
	@echo "  VALUES_FILE             Helm values file (default: $(VALUES_FILE))"

# Build targets
build: compile-code build-image
	@echo "✓ Image built successfully: $(IMAGE)"

compile-code:
	@echo "Building UI..."
	npm run build:ui
	@echo "✓ UI built"
	@echo "Building TypeScript..."
	npm run build
	@echo "✓ TypeScript compiled"

build-image:
	@echo "Building Docker image (tag: $(TAG))..."
	docker build -t $(IMAGE) -f container/agent/Dockerfile .
	@echo "✓ Docker image built: $(IMAGE)"

# Git Server targets
build-git-server:
	@echo "Building git-server image (tag: $(TAG))..."
	docker build -t $(GIT_SERVER_IMAGE) ./container/git-server/
	@echo "✓ Git-server image built: $(GIT_SERVER_IMAGE)"

deploy-git-server: build-git-server load-git-server-image helm-upgrade
	@echo "✓ Git-server deployment complete"

load-git-server-image:
	@echo "Loading git-server image into kind cluster '$(KIND_CLUSTER)'..."
	kind load docker-image $(GIT_SERVER_IMAGE) --name $(KIND_CLUSTER)
	@echo "✓ Git-server image loaded into kind"

deploy-all: build build-git-server load-image load-git-server-image helm-upgrade
	@echo "✓ All deployments complete (AX + git-server)"

# Deploy targets
deploy: build load-image helm-upgrade
	@echo "✓ Deployment complete"

load-image:
	@echo "Loading image into kind cluster '$(KIND_CLUSTER)'..."
	kind load docker-image $(IMAGE) --name $(KIND_CLUSTER)
	@echo "✓ Image loaded into kind"

helm-upgrade:
	@echo "Helm upgrade (tag: $(TAG))..."
	helm upgrade --install ax ./charts/ax -f $(VALUES_FILE) -n $(NAMESPACE) \
		--set imageDefaults.tag=$(TAG) \
		--set gitServer.image.repository=$(GIT_SERVER_IMAGE) \
		--set gitServer.image.tag=$(TAG)
	@echo "✓ Helm upgrade complete"
	@echo "Waiting for deployments to be ready..."
	kubectl rollout status deployment/ax-host -n $(NAMESPACE) --timeout=120s
	kubectl rollout status deployment/ax-git -n $(NAMESPACE) --timeout=60s || true

# Utility targets
clean:
	@echo "Removing local Docker images..."
	docker rmi $(IMAGE) $(GIT_SERVER_IMAGE) 2>/dev/null || true
	@echo "✓ Images removed"

status:
	@echo "Kind cluster: $(KIND_CLUSTER)"
	@echo "Namespace: $(NAMESPACE)"
	@echo "Tag: $(TAG)"
	@echo ""
	@echo "Pod Status:"
	kubectl get pods -n $(NAMESPACE)
	@echo ""
	@echo "Images in use:"
	@echo "  AX:         $(IMAGE)"
	@echo "  Git-server: $(GIT_SERVER_IMAGE)"

logs-host:
	kubectl logs -n $(NAMESPACE) -l app=ax-host --tail=50 -f

logs-sandbox:
	kubectl logs -n $(NAMESPACE) -l app=ax-sandbox --tail=50 -f

# Development shortcuts — compile, build, load, helm upgrade
dev-cycle: build load-image helm-upgrade
	@echo "✓ Development cycle complete"

rebuild: compile-code build-image load-image helm-upgrade
	@echo "✓ Rebuild complete"

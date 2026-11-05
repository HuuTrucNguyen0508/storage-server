# Lab platform. See platform/README.md. Every target is safe to rerun.
SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help
.PHONY: help up down status creds tools secrets backup restore e2e smoke users

help: ## List targets
	@grep -hE '^[a-z0-9%-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

up: ## Create or converge the cluster and everything on it
	@scripts/up.sh

down: ## Delete the cluster (keeps DATA_DIR and .local/; needs CONFIRM=1)
	@CONFIRM=$(CONFIRM) scripts/down.sh

status: ## Nodes, releases, unhealthy pods, volumes, routes
	@scripts/status.sh

creds: ## Print URLs and logins
	@scripts/creds.sh

tools: ## Download pinned kind and kubectl into .local/bin
	@scripts/tools.sh

secrets: ## Generate .local/ secrets (idempotent)
	@scripts/secrets.sh

deploy-%: ## Build and deploy services/<app> (for example make deploy-storage)
	@scripts/deploy-app.sh $*

backup: ## Run every <app>-db-backup CronJob now and wait
	@scripts/backup.sh $(APPS)

restore: ## Restore the newest dump of every app (or APPS="todo") into its database
	@scripts/restore.sh $(APPS)

load-%: ## Run a k6 scenario from loadgen/ (for example make load-smoke)
	@if [ -x loadgen/run.sh ] || [ -f loadgen/run.sh ]; then bash loadgen/run.sh $*; else echo "loadgen/run.sh does not exist yet" >&2; exit 1; fi

e2e: ## Run the end-to-end tests
	@if [ -f tests/e2e/run.sh ]; then bash tests/e2e/run.sh; else echo "tests/e2e/run.sh does not exist yet" >&2; exit 1; fi

smoke: ## Security and platform checks against the running cluster
	@scripts/smoke.sh

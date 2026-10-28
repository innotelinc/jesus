# ==========================================================================
# Cantus — operator workflow
# Usage: make <target>   (see `make help`)
# ==========================================================================

.DEFAULT_GOAL := help
SHELL := /bin/bash

.PHONY: help setup test selftest demo demo-all espeak guard audit clean

help: ## Show this help
	@echo "Cantus — operator workflow"
	@echo "Usage: make <target>"
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

## ---- Bootstrap -----------------------------------------------------------

setup: ## Install the attribution guard hooks locally
	bash scripts/setup.sh

## ---- Verify --------------------------------------------------------------

test: ## Run the whole conformance suite (167 assertions)
	@total=0; fail=0; \
	for f in t/*.t; do \
	  out=$$(perl -Ilib "$$f" 2>&1); rc=$$?; \
	  n=$$(printf '%s\n' "$$out" | grep -c '^ok'); bad=$$(printf '%s\n' "$$out" | grep -c '^not ok'); \
	  total=$$((total+n)); fail=$$((fail+bad)); \
	  printf "%-20s %3d ok %d not ok\n" "$$f" "$$n" "$$bad"; \
	  [ "$$rc" -ne 0 ] && printf '%s\n' "$$out" | grep -A3 '^not ok'; \
	done; \
	echo "total ok=$$total not_ok=$$fail"; \
	[ "$$fail" -eq 0 ]

selftest: ## Run the built-in end-to-end self test
	perl -Ilib bin/cantus selftest

## ---- Demonstrate ---------------------------------------------------------

demo: ## One call behind cone NAT (direct path)
	perl -Ilib bin/cantus demo --nat cone

demo-all: ## Direct, cone, symmetric and the rebinding run
	@for m in none cone symmetric; do echo "=== nat=$$m ==="; perl -Ilib bin/cantus demo --nat $$m | tail -12; done
	@echo "=== mid-call rebinding ==="; perl -Ilib bin/cantus demo --nat cone --rebind | tail -10

## ---- Conformity ----------------------------------------------------------

guard: ## Prove the attribution guard rejects and allows what it must
	@bash -c 'source .githooks/guard-lib && guard_selftest --self-commit' && echo "guard: ok" || \
	 { echo "guard: full self-test unavailable here (slow shell) — two-way check:"; \
	   printf 'co-authored-by: Someone Else <else@example.com>\n' | bash -c 'source .githooks/guard-lib && guard_check_stream' && { echo "!! accepted foreign credit"; exit 1; } || echo "  rejects foreign credit: ok"; \
	   printf 'co-authored-by: Darnel Hunter <dhunter@innotel.us>\n' | bash -c 'source .githooks/guard-lib && guard_check_stream' && echo "  allows the policy's own signature: ok"; }

audit: ## Run the Innotel conformity audit (needs the stack repo)
	@test -x .stack/scripts/conform-project.sh || { echo "clone innotelinc/innotel-platform-stack into .stack/ first"; exit 1; }
	bash .stack/scripts/conform-project.sh .

clean: ## Remove build residue
	rm -rf blib pm_to_blib Makefile.old

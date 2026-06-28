BIN := synapse
BINDIR := bin
SRC := src/synapse.ts
BREW_PREFIX := $(shell command -v brew >/dev/null 2>&1 && brew --prefix)
PREFIX ?= $(if $(BREW_PREFIX),$(BREW_PREFIX)/bin,~/.local/bin)
# Tag (most recent annotated/lightweight tag, falling back to short SHA, with
# a -dirty suffix on uncommitted changes) baked into the binary at compile
# time via bun's --define so `synapse version` reflects exactly what was
# built, with no separate VERSION file to keep in sync.
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

.PHONY: build init clean install test unit smoke e2e

build: $(SRC)
	mkdir -p $(BINDIR)
	bun build $(SRC) --compile --define SYNAPSE_VERSION="\"$(VERSION)\"" --outfile $(BINDIR)/$(BIN)

init: build
	./$(BINDIR)/$(BIN) init

install: build
	mkdir -p $(PREFIX)
	ln -sf "$(abspath $(BINDIR)/$(BIN))" $(PREFIX)/$(BIN)
	@echo "Installed $(BIN) to $(PREFIX)/$(BIN)"

unit:
	bun test

smoke: build
	tmp=$$(mktemp -d); trap 'rm -rf "$$tmp"' EXIT; SYNAPSE_DB="$$tmp/synapse.db" ./$(BINDIR)/$(BIN) init >/dev/null; SYNAPSE_DB="$$tmp/synapse.db" ./$(BINDIR)/$(BIN) status

e2e: build
	bash tests/e2e-monitor.sh

test: unit smoke e2e

clean:
	rm -rf $(BINDIR) .*.bun-build

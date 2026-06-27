BIN := synapse
BINDIR := bin
SRC := src/synapse.ts
BREW_PREFIX := $(shell command -v brew >/dev/null 2>&1 && brew --prefix)
PREFIX ?= $(if $(BREW_PREFIX),$(BREW_PREFIX)/bin,~/.local/bin)

.PHONY: build init clean install test unit smoke e2e

build: $(SRC)
	mkdir -p $(BINDIR)
	bun build $(SRC) --compile --outfile $(BINDIR)/$(BIN)

init: build
	./$(BINDIR)/$(BIN) init

install: build
	mkdir -p $(PREFIX)
	ln -sf "$(abspath $(BINDIR)/$(BIN))" $(PREFIX)/$(BIN)
	@echo "Installed $(BIN) to $(PREFIX)/$(BIN)"

unit:
	bun test

smoke: build
	./$(BINDIR)/$(BIN) status

e2e: build
	bash tests/e2e-monitor.sh

test: unit smoke e2e

clean:
	rm -rf $(BINDIR) .*.bun-build

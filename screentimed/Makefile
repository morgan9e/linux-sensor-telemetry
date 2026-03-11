PREFIX ?= $(HOME)/.local
BINDIR = $(PREFIX)/bin
EXTENSIONDIR = $(HOME)/.local/share/gnome-shell/extensions/
SERVICEDIR = $(HOME)/.config/systemd/user
DESKTOPDIR = $(HOME)/.local/share/applications

EXTENTION = "app-tracker@local"

.PHONY: install install-extension install-daemon install-viewer uninstall

install: install-extension install-daemon install-viewer

install-extension:
	mkdir -p $(EXTENSIONDIR)
	cp $(EXTENSION)/extension.js $(EXTENSIONDIR)/$(EXTENSION)
	cp $(EXTENSION)/metadata.json $(EXTENSIONDIR)/$(EXTENSION)

install-daemon:
	mkdir -p $(BINDIR)
	cp screentimed $(BINDIR)/screentimed
	chmod +x $(BINDIR)/screentimed
	mkdir -p $(SERVICEDIR)
	cp org.screentimed.service $(SERVICEDIR)/

install-viewer:
	mkdir -p $(BINDIR)
	cp screentime-viewer $(BINDIR)/screentime-viewer
	chmod +x $(BINDIR)/screentime-viewer
	mkdir -p $(DESKTOPDIR)
	cp screentime-viewer.desktop $(DESKTOPDIR)/

uninstall:
	systemctl --user disable --now screentimed || true
	gnome-extensions disable $(EXTENSION) || true
	rm -v $(BINDIR)/screentimed
	rm -v $(BINDIR)/screentime-viewer
	rm -v $(SERVICEDIR)/org.screentimed.service
	rm -v $(DESKTOPDIR)/screentime-viewer.desktop
	rm -rv $(EXTENSIONDIR)/$(EXTENSION)
	systemctl --user daemon-reload
	@echo "uninstalled."

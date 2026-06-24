# Top-level Makefile for linux-sensor-telemetry.
# Delegates to each subproject that ships its own Makefile.
# (org.batteryd has no Makefile yet, so it is not included.)

SUBPROJECTS = org.sensord screentimed

.PHONY: install uninstall $(SUBPROJECTS)

install: $(SUBPROJECTS)

$(SUBPROJECTS):
	$(MAKE) -C $@ install

uninstall:
	$(MAKE) -C screentimed uninstall
	$(MAKE) -C org.sensord/gnome-sensor-tray uninstall

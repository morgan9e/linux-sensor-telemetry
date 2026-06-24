UUID = sensor-tray@local
SRC = src
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all schemas install uninstall zip clean test

install: schemas
	rm -rf $(INSTALL_DIR)
	cp -r ./$(SRC) $(INSTALL_DIR)

all: schemas

schemas:
	glib-compile-schemas $(SRC)/schemas/

uninstall:
	rm -rf $(INSTALL_DIR)

zip: schemas
	cd $(SRC) && zip -x "*.pot" -x "*.po" -r ../$(UUID).zip *

clean:
	rm -f $(UUID).zip
	rm -f $(SRC)/schemas/gschemas.compiled

test: install
	dbus-run-session -- gnome-shell --devkit --wayland

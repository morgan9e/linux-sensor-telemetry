install:
	sudo install -m 0755 sensord.py /usr/local/bin/sensord
	sudo install -m 0644 org.sensord.service /etc/systemd/system/org.sensord.service
	sudo /usr/local/bin/sensord --setup
	sudo systemctl daemon-reload
	$(MAKE) -C gnome-sensor-tray install

enable:
	sudo systemctl enable --now org.sensord.service

uninstall:
	-sudo systemctl disable --now org.sensord.service
	sudo rm -f /etc/systemd/system/org.sensord.service
	sudo rm -f /usr/local/bin/sensord
	sudo rm -f /etc/dbus-1/system.d/org.sensord.conf
	sudo systemctl daemon-reload
	$(MAKE) -C gnome-sensor-tray uninstall

.PHONY: install enable uninstall

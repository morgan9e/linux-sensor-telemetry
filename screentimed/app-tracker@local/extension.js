import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const IFACE = `<node>
  <interface name="org.gnome.Shell.UsageTracker">
    <signal name="FocusChanged">
      <arg name="app_id" type="s"/>
    </signal>
    <signal name="RunningAppsChanged">
      <arg name="app_ids" type="as"/>
    </signal>
    <method name="GetFocus">
      <arg direction="out" name="app_id" type="s"/>
    </method>
    <method name="GetRunningApps">
      <arg direction="out" name="app_ids" type="as"/>
    </method>
  </interface>
</node>`;

export default class FocusTracker extends Extension {
    enable() {
        this._currentApp = '';
        this._tracker = Shell.WindowTracker.get_default();
        this._appSystem = Shell.AppSystem.get_default();

        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._dbus.export(Gio.DBus.session, '/org/gnome/Shell/UsageTracker');

        this._focusSig = this._tracker.connect('notify::focus-app', () => {
            const id = this._resolveFocusId();
            if (id !== this._currentApp) {
                this._currentApp = id;
                this._dbus.emit_signal('FocusChanged',
                    new GLib.Variant('(s)', [id]));
            }
        });

        this._appSig = this._appSystem.connect('app-state-changed', () => {
            const ids = this._appSystem.get_running().map(a => this._resolveAppId(a));
            this._dbus.emit_signal('RunningAppsChanged',
                new GLib.Variant('(as)', [ids]));
        });
    }

    _resolveFocusId() {
        const app = this._tracker.focus_app;
        if (!app)
            return '';
        return this._resolveAppId(app);
    }

    _resolveAppId(app) {
        const id = app.get_id();
        if (id.endsWith('.desktop'))
            return id;
        // fallback: use window class
        const windows = app.get_windows();
        if (windows.length > 0) {
            const wmClass = windows[0].get_wm_class();
            if (wmClass)
                return `${wmClass}.desktop`;
        }
        return id;
    }

    disable() {
        this._tracker.disconnect(this._focusSig);
        this._appSystem.disconnect(this._appSig);
        this._dbus.unexport();
        this._dbus = null;
    }

    GetFocus() {
        return this._currentApp;
    }

    GetRunningApps() {
        return this._appSystem.get_running().map(a => this._resolveAppId(a));
    }
}

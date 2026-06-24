import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import SensorClient from './sensorClient.js';
import SensorItem from './sensorItem.js';

function safeIcon(names) {
    if (typeof names === 'string')
        names = [names];
    return new Gio.ThemedIcon({ names });
}

function formatByUnit(unit, val, dec) {
    if (!unit)
        return (dec ? '%.2f' : '%.1f').format(val);

    switch (unit) {
    case '%':
        return (dec ? '%.1f' : '%.0f').format(val) + '%';
    case 'W':
        return (dec ? '%.2f' : '%.1f').format(val) + ' W';
    case 'Wh':
        return '%.1f Wh'.format(val);
    case 'V':
        return '%.2f V'.format(val);
    case 'A':
        return '%.2f A'.format(val);
    case 'Ah':
        return '%.2f Ah'.format(val);
    case '\u00b0C':
        return (dec ? '%.1f' : '%.0f').format(val) + '\u00b0C';
    case 'bytes':
        if (val >= 1073741824) return '%.1f GiB'.format(val / 1073741824);
        if (val >= 1048576) return '%.0f MiB'.format(val / 1048576);
        return '%.0f KiB'.format(val / 1024);
    case 'count':
        return '%.0f'.format(val);
    case 'bool':
        return val ? 'Yes' : 'No';
    default:
        if (unit.startsWith('enum:')) {
            let names = unit.slice(5).split(',');
            let idx = Math.round(val) - 1;
            return (idx >= 0 && idx < names.length) ? names[idx] : 'Unknown';
        }
        return (dec ? '%.2f' : '%.1f').format(val) + ' ' + unit;
    }
}

function autoSummary(readings, units) {
    if (!readings || !units)
        return null;
    if ('total' in readings) return { key: 'total', val: readings['total'] };
    if ('percent' in readings) return { key: 'percent', val: readings['percent'] };
    for (let k of Object.keys(readings))
        if (k.endsWith('/percent')) return { key: k, val: readings[k] };
    let k = Object.keys(readings)[0];
    return k ? { key: k, val: readings[k] } : null;
}

const SORT_ORDER = { Thermal: 0, Cpu: 1, Power: 2, Memory: 3, Battery: 4 };

function catIcon(cat, meta) {
    let m = meta?.get(cat);
    if (m?.icon)
        return [m.icon, 'dialog-information-symbolic'];
    return ['dialog-information-symbolic'];
}

function formatSensor(cat, key, val, dec, meta) {
    let unit = meta?.get(cat)?.units?.[key] ?? null;
    return formatByUnit(unit, val, dec);
}

class SensorTrayButton extends PanelMenu.Button {

    static {
        GObject.registerClass(this);
    }

    constructor(settings, path) {
        super(0);

        this._settings = settings;
        this._path = path;
        this._client = new SensorClient();

        this._subMenus = {};
        this._menuItems = {};
        this._lastKeys = null;

        this._panelBox = new St.BoxLayout();
        this.add_child(this._panelBox);
        this._hotLabels = {};
        this._hotIcons = {};

        this._buildPanel();

        this._sigIds = [];
        this._connectSetting('hot-sensors', () => { this._buildPanel(); this._updatePanel(); this._syncPinOrnaments(); });
        this._connectSetting('show-icon-on-panel', () => { this._buildPanel(); this._updatePanel(); });
        this._connectSetting('panel-spacing', () => { this._buildPanel(); this._updatePanel(); });
        this._connectSetting('show-decimal-value', () => this._refresh());
        this._connectSetting('position-in-panel', () => this._reposition());
        this._connectSetting('panel-box-index', () => this._reposition());
        this._connectSetting('update-interval', () => this._restartRefreshTimer());

        this._dirty = false;
        this._refreshTimerId = 0;
        this._startRefreshTimer();

        this._client.start((cat, readings) => this._onSensorChanged(cat, readings));

        this.connect('destroy', () => this._onDestroy());

        this._repositionTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._reposition();
            this._repositionTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _connectSetting(key, cb) {
        this._sigIds.push(this._settings.connect('changed::' + key, cb));
    }

    _buildPanel() {
        this._panelBox.destroy_all_children();
        this._hotLabels = {};
        this._hotIcons = {};

        let hot = this._settings.get_strv('hot-sensors');
        let showIcon = this._settings.get_boolean('show-icon-on-panel');

        if (hot.length === 0) {
            this._panelBox.add_child(new St.Icon({
                style_class: 'system-status-icon',
                gicon: safeIcon(['sensors-temperature-symbolic', 'dialog-information-symbolic']),
            }));
            return;
        }

        let meta = this._client.meta;

        for (let i = 0; i < hot.length; i++) {
            let fullKey = hot[i];
            let cat = fullKey.split('/')[0];

            if (i > 0) {
                let spacing = this._settings.get_int('panel-spacing');
                this._panelBox.add_child(new St.Widget({ width: spacing }));
            }

            if (showIcon) {
                let icon = new St.Icon({
                    style_class: 'system-status-icon',
                    gicon: safeIcon(catIcon(cat, meta)),
                });
                this._hotIcons[fullKey] = icon;
                this._panelBox.add_child(icon);
            }

            let label = new St.Label({
                text: '\u2026',
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: showIcon ? 'sensortray-panel-icon-label' : 'sensortray-panel-label',
            });
            this._hotLabels[fullKey] = label;
            this._panelBox.add_child(label);
        }
    }

    _updatePanel() {
        let dec = this._settings.get_boolean('show-decimal-value');
        let meta = this._client.meta;

        for (let [fullKey, label] of Object.entries(this._hotLabels)) {
            let parts = fullKey.split('/');
            let cat = parts[0];
            let key = parts.slice(1).join('/');
            let readings = this._client.readings.get(cat);

            if (!readings || !(key in readings)) {
                label.text = '\u2026';
                continue;
            }

            label.text = formatSensor(cat, key, readings[key], dec, meta);
        }
    }

    _onSensorChanged(category, _readings) {
        if (category === null) {
            this._menuItems = {};
            this._subMenus = {};
            this._lastKeys = null;
            this.menu.removeAll();
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(_('sensord is not running')));
            for (let l of Object.values(this._hotLabels))
                l.text = '\u26a0';
            return;
        }

        this._dirty = true;
    }

    _startRefreshTimer() {
        let seconds = this._settings.get_int('update-interval');
        let intervalMs = seconds * 1000;
        this._refreshTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
            if (this._dirty) {
                this._dirty = false;
                this._rebuildMenuIfNeeded();
                this._updateValues();
                this._updatePanel();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _restartRefreshTimer() {
        if (this._refreshTimerId) {
            GLib.Source.remove(this._refreshTimerId);
            this._refreshTimerId = 0;
        }
        this._startRefreshTimer();
    }

    _sortedEntries() {
        let entries = [];
        for (let [cat, readings] of this._client.readings) {
            let order = SORT_ORDER[cat] ?? 99;
            for (let key of Object.keys(readings))
                entries.push({ cat, key, fullKey: cat + '/' + key, sortOrder: order });
        }
        entries.sort((a, b) => {
            if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
            if (a.cat !== b.cat) return a.cat.localeCompare(b.cat);
            return a.key.localeCompare(b.key, undefined, { numeric: true });
        });
        return entries;
    }

    _rebuildMenuIfNeeded() {
        let entries = this._sortedEntries();
        let keyStr = entries.map(e => e.fullKey).join('\n');

        if (this._lastKeys === keyStr)
            return;

        this._lastKeys = keyStr;
        this.menu.removeAll();
        this._menuItems = {};
        this._subMenus = {};

        let hot = this._settings.get_strv('hot-sensors');

        let grouped = new Map();
        for (let e of entries) {
            if (!grouped.has(e.cat))
                grouped.set(e.cat, []);
            grouped.get(e.cat).push(e);
        }

        let meta = this._client.meta;

        for (let [cat, catEntries] of grouped) {
            let iconNames = catIcon(cat, meta);

            let sub = new PopupMenu.PopupSubMenuMenuItem(cat, true);
            sub.icon.gicon = safeIcon(iconNames);
            this._subMenus[cat] = sub;
            this.menu.addMenuItem(sub);

            for (let e of catEntries) {
                let gicon = safeIcon(iconNames);
                let item = new SensorItem(gicon, e.fullKey, e.key, '\u2026');

                if (hot.includes(e.fullKey))
                    item.pinned = true;

                item.connect('activate', () => this._togglePin(item));

                this._menuItems[e.fullKey] = item;
                sub.menu.addMenuItem(item);
            }
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        let settingsItem = new PopupMenu.PopupMenuItem(_('Settings'));
        settingsItem.connect('activate', () => {
            try {
                Gio.Subprocess.new(
                    ['gnome-extensions', 'prefs', 'sensor-tray@local'],
                    Gio.SubprocessFlags.NONE,
                );
            } catch (e) {
                console.error('sensor-tray: cannot open prefs:', e.message);
            }
        });
        this.menu.addMenuItem(settingsItem);
    }

    _updateValues() {
        let dec = this._settings.get_boolean('show-decimal-value');
        let meta = this._client.meta;

        for (let [cat, readings] of this._client.readings) {
            let units = meta.get(cat)?.units;

            for (let [key, val] of Object.entries(readings)) {
                let item = this._menuItems[cat + '/' + key];
                if (item)
                    item.value = formatSensor(cat, key, val, dec, meta);
            }

            let sub = this._subMenus[cat];
            if (sub && sub.status) {
                let s = autoSummary(readings, units);
                if (s)
                    sub.status.text = formatByUnit(units?.[s.key], s.val, dec);
            }
        }
    }

    _syncPinOrnaments() {
        let hot = this._settings.get_strv('hot-sensors');
        for (let [key, item] of Object.entries(this._menuItems))
            item.pinned = hot.includes(key);
    }

    _togglePin(item) {
        let hot = this._settings.get_strv('hot-sensors');

        if (item.pinned)
            hot = hot.filter(k => k !== item.key);
        else
            hot.push(item.key);

        this._settings.set_strv('hot-sensors', hot);
    }

    _refresh() {
        this._lastKeys = null;
        this._rebuildMenuIfNeeded();
        this._updateValues();
        this._updatePanel();
    }

    _reposition() {
        try {
            if (!this.container?.get_parent()) return;
            this.container.get_parent().remove_child(this.container);

            let boxes = {
                0: Main.panel._leftBox,
                1: Main.panel._centerBox,
                2: Main.panel._rightBox,
            };
            let pos = this._settings.get_int('position-in-panel');
            let idx = this._settings.get_int('panel-box-index');
            (boxes[pos] || boxes[2]).insert_child_at_index(this.container, idx);
        } catch (e) {
            console.error('sensor-tray: reposition failed:', e.message);
        }
    }

    _onDestroy() {
        this._client.destroy();
        if (this._refreshTimerId) {
            GLib.Source.remove(this._refreshTimerId);
            this._refreshTimerId = 0;
        }
        if (this._repositionTimeoutId) {
            GLib.Source.remove(this._repositionTimeoutId);
            this._repositionTimeoutId = 0;
        }
        for (let id of this._sigIds)
            this._settings.disconnect(id);
        this._sigIds = [];
    }
}

export default class SensorTrayExtension extends Extension {

    enable() {
        this._button = new SensorTrayButton(this.getSettings(), this.path);
        Main.panel.addToStatusArea('sensor-tray', this._button);
    }

    disable() {
        this._button?.destroy();
        this._button = null;
    }
}

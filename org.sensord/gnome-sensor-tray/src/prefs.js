import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SensorTrayPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        this._settings = this.getSettings();

        let page = new Adw.PreferencesPage({
            title: _('Sensor Tray'),
            icon_name: 'utilities-system-monitor-symbolic',
        });

        page.add(this._createPinnedGroup());
        page.add(this._createDisplayGroup());
        page.add(this._createPositionGroup());

        window.add(page);
    }

    _createPinnedGroup() {
        let group = new Adw.PreferencesGroup({
            title: _('Pinned Sensors'),
            description: _('Sensors shown in the top bar. Toggle pins from the dropdown menu.'),
        });

        this._pinnedGroup = group;
        this._rebuildPinnedRows();

        this._settings.connect('changed::hot-sensors', () => this._rebuildPinnedRows());

        return group;
    }

    _rebuildPinnedRows() {
        // clear existing rows
        if (this._pinnedRows) {
            for (let row of this._pinnedRows)
                this._pinnedGroup.remove(row);
        }
        this._pinnedRows = [];

        let hot = this._settings.get_strv('hot-sensors');

        if (hot.length === 0) {
            let empty = new Adw.ActionRow({
                title: _('No sensors pinned'),
                subtitle: _('Click sensors in the dropdown menu to pin them'),
            });
            this._pinnedGroup.add(empty);
            this._pinnedRows.push(empty);
            return;
        }

        for (let idx = 0; idx < hot.length; idx++) {
            let fullKey = hot[idx];
            // show "Category / key" as title/subtitle
            let parts = fullKey.split('/');
            let cat = parts[0];
            let key = parts.slice(1).join('/');

            let row = new Adw.ActionRow({
                title: key,
                subtitle: cat,
            });

            let btnBox = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 4,
                valign: Gtk.Align.CENTER,
            });

            let upBtn = new Gtk.Button({
                icon_name: 'go-up-symbolic',
                css_classes: ['flat'],
                sensitive: idx > 0,
            });
            upBtn.connect('clicked', () => {
                let arr = this._settings.get_strv('hot-sensors');
                let i = arr.indexOf(fullKey);
                if (i > 0) {
                    [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
                    this._settings.set_strv('hot-sensors', arr);
                }
            });

            let downBtn = new Gtk.Button({
                icon_name: 'go-down-symbolic',
                css_classes: ['flat'],
                sensitive: idx < hot.length - 1,
            });
            downBtn.connect('clicked', () => {
                let arr = this._settings.get_strv('hot-sensors');
                let i = arr.indexOf(fullKey);
                if (i >= 0 && i < arr.length - 1) {
                    [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
                    this._settings.set_strv('hot-sensors', arr);
                }
            });

            let removeBtn = new Gtk.Button({
                icon_name: 'edit-delete-symbolic',
                css_classes: ['flat'],
            });
            removeBtn.connect('clicked', () => {
                let arr = this._settings.get_strv('hot-sensors');
                this._settings.set_strv('hot-sensors', arr.filter(k => k !== fullKey));
            });

            btnBox.append(upBtn);
            btnBox.append(downBtn);
            btnBox.append(removeBtn);
            row.add_suffix(btnBox);

            this._pinnedGroup.add(row);
            this._pinnedRows.push(row);
        }
    }

    _createDisplayGroup() {
        let group = new Adw.PreferencesGroup({ title: _('Display') });

        let unitRow = new Adw.ComboRow({
            title: _('Temperature Unit'),
            model: new Gtk.StringList({ strings: ['\u00b0C', '\u00b0F'] }),
        });
        this._settings.bind('unit', unitRow, 'selected', Gio.SettingsBindFlags.DEFAULT);
        group.add(unitRow);

        group.add(this._switch(_('Show Decimal Values'), 'show-decimal-value'));
        group.add(this._switch(_('Show Icon on Panel'), 'show-icon-on-panel'));

        let spacingRow = new Adw.SpinRow({
            title: _('Panel Spacing'),
            subtitle: _('Pixels between pinned values'),
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 32, value: 8, step_increment: 1,
            }),
        });
        this._settings.bind('panel-spacing', spacingRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(spacingRow);

        let intervalRow = new Adw.SpinRow({
            title: _('Update Interval'),
            subtitle: _('Seconds between UI updates'),
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 10, value: 1, step_increment: 1,
            }),
        });
        this._settings.bind('update-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(intervalRow);

        return group;
    }

    _createPositionGroup() {
        let group = new Adw.PreferencesGroup({ title: _('Panel Position') });

        let posRow = new Adw.ComboRow({
            title: _('Position'),
            model: new Gtk.StringList({ strings: [_('Left'), _('Center'), _('Right')] }),
        });
        this._settings.bind('position-in-panel', posRow, 'selected', Gio.SettingsBindFlags.DEFAULT);
        group.add(posRow);

        let idxRow = new Adw.SpinRow({
            title: _('Index'),
            adjustment: new Gtk.Adjustment({
                lower: -1, upper: 25, value: 0, step_increment: 1,
            }),
        });
        this._settings.bind('panel-box-index', idxRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(idxRow);

        return group;
    }

    _switch(title, key) {
        let row = new Adw.SwitchRow({ title });
        this._settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}

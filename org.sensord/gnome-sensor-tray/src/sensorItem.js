import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export default class SensorItem extends PopupMenu.PopupBaseMenuItem {

    static {
        GObject.registerClass(this);
    }

    constructor(gicon, key, label, value) {
        super();
        this._key = key;
        this._gicon = gicon;
        this._pinned = false;

        this.add_child(new St.Icon({ style_class: 'popup-menu-icon', gicon }));
        this._label = new St.Label({ text: label, x_expand: true });
        this.add_child(this._label);
        this._value = new St.Label({ text: value });
        this.add_child(this._value);
    }

    get key() { return this._key; }
    get gicon() { return this._gicon; }

    get pinned() { return this._pinned; }
    set pinned(v) {
        this._pinned = v;
        this.setOrnament(v ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
    }

    set value(v) { this._value.text = v; }
    set label(v) { this._label.text = v; }
}

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'org.sensord';
const OBJECT_PATH = '/org/sensord';
const IFACE_PREFIX = 'org.sensord.';

export default class SensorClient {

    constructor() {
        this._conn = null;
        this._signalIds = [];
        this._readings = new Map();
        this._meta = new Map();
        this._onChanged = null;
        this._available = false;
        this._nameWatchId = 0;
    }

    start(onChanged) {
        this._onChanged = onChanged;

        try {
            this._conn = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
        } catch (e) {
            console.error('sensortray: cannot connect to system bus:', e.message);
            return;
        }

        this._nameWatchId = Gio.bus_watch_name_on_connection(
            this._conn,
            BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => this._onNameAppeared(),
            () => this._onNameVanished(),
        );
    }

    _onNameAppeared() {
        this._available = true;
        this._discover();
    }

    _onNameVanished() {
        this._available = false;
        this._unsubscribeAll();
        this._readings.clear();
        this._meta.clear();
        if (this._onChanged)
            this._onChanged(null, null);
    }

    _discover() {
        this._unsubscribeAll();
        this._readings.clear();
        this._meta.clear();

        let introXml;
        try {
            let result = this._conn.call_sync(
                BUS_NAME, OBJECT_PATH,
                'org.freedesktop.DBus.Introspectable', 'Introspect',
                null, GLib.VariantType.new('(s)'),
                Gio.DBusCallFlags.NONE, 3000, null,
            );
            [introXml] = result.deep_unpack();
        } catch (e) {
            console.error('sensortray: introspect failed:', e.message);
            return;
        }

        let ifaces = [];
        let re = /interface\s+name="(org\.sensord\.[^"]+)"/g;
        let m;
        while ((m = re.exec(introXml)) !== null)
            ifaces.push(m[1]);

        for (let iface of ifaces) {
            let category = iface.slice(IFACE_PREFIX.length);

            let sid = this._conn.signal_subscribe(
                BUS_NAME, iface, 'Changed', OBJECT_PATH,
                null, Gio.DBusSignalFlags.NONE,
                (_conn, _sender, _path, _iface, _signal, params) => {
                    let [readings] = params.deep_unpack();
                    this._readings.set(category, readings);
                    if (this._onChanged)
                        this._onChanged(category, readings);
                },
            );
            this._signalIds.push(sid);

            this._conn.call(
                BUS_NAME, OBJECT_PATH, iface, 'GetMeta',
                null, GLib.VariantType.new('(a{sv})'),
                Gio.DBusCallFlags.NONE, 3000, null,
                (conn, res) => {
                    try {
                        let result = conn.call_finish(res);
                        let [meta] = result.deep_unpack();
                        let parsed = {};
                        if (meta['icon'])
                            parsed.icon = meta['icon'].deep_unpack();
                        if (meta['units'])
                            parsed.units = meta['units'].deep_unpack();
                        this._meta.set(category, parsed);
                    } catch (e) {
                        console.debug(`sensortray: GetMeta(${iface}) unavailable:`, e.message);
                    }
                },
            );

            this._conn.call(
                BUS_NAME, OBJECT_PATH, iface, 'GetReadings',
                null, GLib.VariantType.new('(a{sd})'),
                Gio.DBusCallFlags.NONE, 3000, null,
                (conn, res) => {
                    try {
                        let result = conn.call_finish(res);
                        let [readings] = result.deep_unpack();
                        this._readings.set(category, readings);
                        if (this._onChanged)
                            this._onChanged(category, readings);
                    } catch (e) {
                        console.error(`sensortray: GetReadings(${iface}) failed:`, e.message);
                    }
                },
            );
        }
    }

    _unsubscribeAll() {
        if (!this._conn)
            return;
        for (let sid of this._signalIds)
            this._conn.signal_unsubscribe(sid);
        this._signalIds = [];
    }

    get available() { return this._available; }
    get readings() { return this._readings; }
    get meta() { return this._meta; }

    destroy() {
        this._unsubscribeAll();
        if (this._nameWatchId) {
            Gio.bus_unwatch_name(this._nameWatchId);
            this._nameWatchId = 0;
        }
        this._conn = null;
        this._onChanged = null;
        this._readings.clear();
        this._meta.clear();
    }
}

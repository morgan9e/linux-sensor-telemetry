import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'org.sensord';
const OBJECT_PATH = '/org/sensord';
const IFACE_PREFIX = 'org.sensord.';

/**
 * Generic client for all org.sensord.* D-Bus interfaces.
 *
 * Every interface has the same shape:
 *   method  GetReadings() → a{sd}
 *   signal  Changed(a{sd})
 *
 * The client introspects the object once, discovers all sensor interfaces,
 * fetches initial readings, then subscribes to Changed signals.
 * Callers get a flat Map<category, Map<key, double>> that stays current.
 */
export default class SensorClient {

    constructor() {
        this._conn = null;
        this._signalIds = [];
        // category → { key: value } e.g. "Power" → { "package-0": 42.3 }
        this._readings = new Map();
        this._onChanged = null;
        this._available = false;
        this._nameWatchId = 0;
    }

    /**
     * Connect to the system bus and start receiving sensor data.
     * @param {function(string, Object<string,number>)} onChanged
     *   Called with (category, readings) whenever a sensor interface emits Changed
     *   and also once per interface after initial GetReadings.
     */
    start(onChanged) {
        this._onChanged = onChanged;

        try {
            this._conn = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
        } catch (e) {
            console.error('sensortray: cannot connect to system bus:', e.message);
            return;
        }

        // Watch for sensord appearing/disappearing on the bus
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
        if (this._onChanged)
            this._onChanged(null, null); // signal "all gone"
    }

    /**
     * Introspect /org/sensord, find all org.sensord.* interfaces,
     * call GetReadings on each, subscribe to Changed.
     */
    _discover() {
        this._unsubscribeAll();
        this._readings.clear();

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

        // Parse interface names from XML — simple regex is fine here
        let ifaces = [];
        let re = /interface\s+name="(org\.sensord\.[^"]+)"/g;
        let m;
        while ((m = re.exec(introXml)) !== null)
            ifaces.push(m[1]);

        for (let iface of ifaces) {
            let category = iface.slice(IFACE_PREFIX.length); // "Power", "Thermal", etc.

            // Subscribe to Changed signal
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

            // Fetch initial state
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

    /** @returns {boolean} true if sensord is on the bus */
    get available() {
        return this._available;
    }

    /**
     * @returns {Map<string, Object<string,number>>}
     * category → { key: value } snapshot of all current readings
     */
    get readings() {
        return this._readings;
    }

    destroy() {
        this._unsubscribeAll();
        if (this._nameWatchId) {
            Gio.bus_unwatch_name(this._nameWatchId);
            this._nameWatchId = 0;
        }
        this._conn = null;
        this._onChanged = null;
        this._readings.clear();
    }
}

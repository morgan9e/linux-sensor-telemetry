#!/usr/bin/python3 -sP
"""sensord — system sensor bridge for D-Bus.

Reads hardware sensors from sysfs/procfs and exposes them
as D-Bus interfaces for sandboxed and desktop consumers.

Bus:    org.sensord
Object: /org/sensord

Interfaces:
    org.sensord.Power     — RAPL power draw (W)
    org.sensord.Thermal   — hwmon temperatures (°C)
    org.sensord.Cpu       — per-core and total usage (%)
    org.sensord.Memory    — memory utilization (bytes/%)
    org.sensord.Battery   — battery state (%/W/status)

Each interface exposes:
    GetReadings() → a{sd}
    signal Changed(a{sd})

Usage:
    sensord --setup     install D-Bus policy
    sensord             start daemon (via systemd)
"""

import os, sys  # noqa: E401

import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

DBUS_NAME = "org.sensord"
DBUS_PATH = "/org/sensord"
DBUS_CONF = "/etc/dbus-1/system.d/org.sensord.conf"

POLICY = """\
<!DOCTYPE busconfig PUBLIC
  "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
  "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="root">
    <allow own="org.sensord"/>
  </policy>
  <policy context="default">
    <allow send_destination="org.sensord"/>
  </policy>
</busconfig>
"""


def make_iface_xml(name):
    return f"""<interface name="org.sensord.{name}">
  <method name="GetReadings"><arg direction="out" type="a{{sd}}"/></method>
  <signal name="Changed"><arg type="a{{sd}}"/></signal>
</interface>"""


INTROSPECTION = f"""
<node>
  {make_iface_xml("Power")}
  {make_iface_xml("Thermal")}
  {make_iface_xml("Cpu")}
  {make_iface_xml("Memory")}
  {make_iface_xml("Battery")}
</node>
"""


# ── sensors ───────────────────────────────────────────────────


class PowerSensor:
    """RAPL energy counters → watts."""

    RAPL_BASE = "/sys/class/powercap/intel-rapl"

    class Zone:
        __slots__ = ("name", "fd", "wrap", "prev_e", "prev_t")

        def __init__(self, path):
            self.name = self._read(path, "name") or os.path.basename(path)
            self.fd = os.open(os.path.join(path, "energy_uj"), os.O_RDONLY)
            self.wrap = int(self._read(path, "max_energy_range_uj") or 1 << 32)
            self.prev_e = self.prev_t = None

        @staticmethod
        def _read(path, name):
            try:
                with open(os.path.join(path, name)) as f:
                    return f.read().strip()
            except OSError:
                return None

        def sample(self):
            os.lseek(self.fd, 0, os.SEEK_SET)
            e = int(os.read(self.fd, 64))
            t = GLib.get_monotonic_time()

            if self.prev_e is None:
                self.prev_e, self.prev_t = e, t
                return None

            dE = e - self.prev_e
            dt = t - self.prev_t
            self.prev_e, self.prev_t = e, t

            if dE < 0:
                dE += self.wrap
            return dE / dt if dt > 0 else None

        def close(self):
            os.close(self.fd)

    def __init__(self):
        self.zones = []
        if not os.path.isdir(self.RAPL_BASE):
            return
        for root, _, files in os.walk(self.RAPL_BASE):
            if "energy_uj" in files:
                try:
                    z = self.Zone(root)
                    z.sample()  # prime
                    self.zones.append(z)
                    print(f"  power: {z.name}", file=sys.stderr)
                except OSError as e:
                    print(f"  power skip: {e}", file=sys.stderr)

    @property
    def available(self):
        return bool(self.zones)

    def sample(self):
        r = {}
        for z in self.zones:
            w = z.sample()
            if w is not None:
                r[z.name] = round(w, 2)
        return r

    def close(self):
        for z in self.zones:
            z.close()


class ThermalSensor:
    """hwmon temperature sensors → °C."""

    HWMON_BASE = "/sys/class/hwmon"

    class Chip:
        __slots__ = ("label", "fd")

        def __init__(self, label, path):
            self.label = label
            self.fd = os.open(path, os.O_RDONLY)

        def read(self):
            os.lseek(self.fd, 0, os.SEEK_SET)
            return int(os.read(self.fd, 32)) / 1000.0

        def close(self):
            os.close(self.fd)

    def __init__(self):
        self.chips = []
        if not os.path.isdir(self.HWMON_BASE):
            return

        for hwmon in os.listdir(self.HWMON_BASE):
            hwdir = os.path.join(self.HWMON_BASE, hwmon)
            chip_name = self._read_file(os.path.join(hwdir, "name")) or hwmon

            for f in sorted(os.listdir(hwdir)):
                if not f.startswith("temp") or not f.endswith("_input"):
                    continue

                path = os.path.join(hwdir, f)
                idx = f.replace("temp", "").replace("_input", "")
                label_path = os.path.join(hwdir, f"temp{idx}_label")
                label = self._read_file(label_path) or f"temp{idx}"
                full_label = f"{chip_name}/{label}"

                try:
                    chip = self.Chip(full_label, path)
                    chip.read()  # test
                    self.chips.append(chip)
                    print(f"  thermal: {full_label}", file=sys.stderr)
                except OSError as e:
                    print(f"  thermal skip: {e}", file=sys.stderr)

    @staticmethod
    def _read_file(path):
        try:
            with open(path) as f:
                return f.read().strip()
        except OSError:
            return None

    @property
    def available(self):
        return bool(self.chips)

    def sample(self):
        r = {}
        for c in self.chips:
            try:
                r[c.label] = round(c.read(), 1)
            except (OSError, ValueError):
                pass
        return r

    def close(self):
        for c in self.chips:
            c.close()


class CpuSensor:
    """/proc/stat → per-core and total CPU usage %."""

    def __init__(self):
        self.fd = None
        self.prev = {}

        try:
            self.fd = os.open("/proc/stat", os.O_RDONLY)
            self._read_stat()  # prime
            print(f"  cpu: {len(self.prev)} entries", file=sys.stderr)
        except OSError as e:
            print(f"  cpu skip: {e}", file=sys.stderr)

    @property
    def available(self):
        return self.fd is not None

    def _read_stat(self):
        os.lseek(self.fd, 0, os.SEEK_SET)
        raw = os.read(self.fd, 8192).decode()
        entries = {}
        for line in raw.splitlines():
            if not line.startswith("cpu"):
                break
            parts = line.split()
            name = parts[0]
            vals = [int(v) for v in parts[1:]]
            # user nice system idle iowait irq softirq steal
            idle = vals[3] + vals[4] if len(vals) > 4 else vals[3]
            total = sum(vals)
            entries[name] = (idle, total)
        return entries

    def sample(self):
        cur = self._read_stat()
        r = {}
        for name, (idle, total) in cur.items():
            if name in self.prev:
                pi, pt = self.prev[name]
                dt = total - pt
                di = idle - pi
                if dt > 0:
                    label = "total" if name == "cpu" else name
                    r[label] = round(100.0 * (1.0 - di / dt), 1)
        self.prev = cur
        return r

    def close(self):
        if self.fd is not None:
            os.close(self.fd)


class MemorySensor:
    """/proc/meminfo → memory stats in bytes and usage %."""

    KEYS = ("MemTotal", "MemAvailable", "MemFree", "SwapTotal", "SwapFree")

    def __init__(self):
        self.fd = None
        try:
            self.fd = os.open("/proc/meminfo", os.O_RDONLY)
            self.sample()  # test
            print("  memory: ok", file=sys.stderr)
        except OSError as e:
            print(f"  memory skip: {e}", file=sys.stderr)

    @property
    def available(self):
        return self.fd is not None

    def sample(self):
        os.lseek(self.fd, 0, os.SEEK_SET)
        raw = os.read(self.fd, 4096).decode()

        vals = {}
        for line in raw.splitlines():
            parts = line.split()
            key = parts[0].rstrip(":")
            if key in self.KEYS:
                vals[key] = int(parts[1]) * 1024  # kB → bytes

        r = {}
        mt = vals.get("MemTotal", 0)
        ma = vals.get("MemAvailable", 0)
        st = vals.get("SwapTotal", 0)
        sf = vals.get("SwapFree", 0)

        if mt:
            r["total"] = float(mt)
            r["available"] = float(ma)
            r["used"] = float(mt - ma)
            r["percent"] = round(100.0 * (1.0 - ma / mt), 1)
        if st:
            r["swap_total"] = float(st)
            r["swap_used"] = float(st - sf)
            r["swap_percent"] = round(100.0 * (1.0 - sf / st), 1) if st else 0.0

        return r

    def close(self):
        if self.fd is not None:
            os.close(self.fd)


class BatterySensor:
    """power_supply sysfs → battery state."""

    PS_BASE = "/sys/class/power_supply"

    # status string → numeric code for a{sd}
    STATUS_MAP = {
        "Charging": 1.0, "Discharging": 2.0,
        "Not charging": 3.0, "Full": 4.0,
    }

    class Supply:
        __slots__ = ("name", "path", "is_battery")

        def __init__(self, name, path, is_battery):
            self.name = name
            self.path = path
            self.is_battery = is_battery

    def __init__(self):
        self.supplies = []
        if not os.path.isdir(self.PS_BASE):
            return

        for entry in sorted(os.listdir(self.PS_BASE)):
            path = os.path.join(self.PS_BASE, entry)
            ptype = self._read(path, "type")
            if ptype == "Battery":
                self.supplies.append(self.Supply(entry, path, True))
                print(f"  battery: {entry}", file=sys.stderr)
            elif ptype == "Mains":
                self.supplies.append(self.Supply(entry, path, False))
                print(f"  battery: {entry} (ac)", file=sys.stderr)

    @staticmethod
    def _read(path, name):
        try:
            with open(os.path.join(path, name)) as f:
                return f.read().strip()
        except OSError:
            return None

    @property
    def available(self):
        return any(s.is_battery for s in self.supplies)

    def sample(self):
        r = {}
        for s in self.supplies:
            if s.is_battery:
                cap = self._read(s.path, "capacity")
                if cap is not None:
                    r[f"{s.name}/percent"] = float(cap)

                status = self._read(s.path, "status")
                if status is not None:
                    r[f"{s.name}/status"] = self.STATUS_MAP.get(status, 0.0)

                power = self._read(s.path, "power_now")
                if power is not None:
                    r[f"{s.name}/power"] = round(int(power) / 1e6, 2)

                e_now = self._read(s.path, "energy_now")
                e_full = self._read(s.path, "energy_full")
                if e_now is not None and e_full is not None:
                    r[f"{s.name}/energy_now"] = round(int(e_now) / 1e6, 2)
                    r[f"{s.name}/energy_full"] = round(int(e_full) / 1e6, 2)

                cycles = self._read(s.path, "cycle_count")
                if cycles is not None:
                    r[f"{s.name}/cycles"] = float(cycles)
            else:
                online = self._read(s.path, "online")
                if online is not None:
                    r[f"{s.name}/online"] = float(online)
        return r

    def close(self):
        pass


# ── daemon ────────────────────────────────────────────────────


SENSORS = {
    "Power":   (PowerSensor,   1),   # iface name, interval (sec)
    "Thermal": (ThermalSensor, 2),
    "Cpu":     (CpuSensor,     1),
    "Memory":  (MemorySensor,  2),
    "Battery": (BatterySensor, 5),
}


class Daemon:
    def __init__(self):
        self.loop = GLib.MainLoop()
        self.bus = None
        self.sensors = {}     # name → sensor instance
        self.readings = {}    # name → latest {key: value}
        self.pending = {}     # name → (cls, interval) — not yet available
        self.node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION)

        for name, (cls, interval) in SENSORS.items():
            sensor = cls()
            if sensor.available:
                self.sensors[name] = sensor
                self.readings[name] = {}
            else:
                self.pending[name] = (cls, interval)

        if not self.sensors and not self.pending:
            raise RuntimeError("no sensors available")

        Gio.bus_own_name(
            Gio.BusType.SYSTEM, DBUS_NAME, Gio.BusNameOwnerFlags.NONE,
            self._on_bus, None, lambda *_: self.loop.quit(),
        )

    def _on_bus(self, conn, _name):
        self.bus = conn
        iface_map = {i.name: i for i in self.node.interfaces}
        for name in self.sensors:
            conn.register_object(
                DBUS_PATH, iface_map[f"org.sensord.{name}"],
                self._on_call, None, None,
            )
        for name in self.pending:
            conn.register_object(
                DBUS_PATH, iface_map[f"org.sensord.{name}"],
                self._on_call, None, None,
            )
        print(f"sensord: {', '.join(self.sensors)}", file=sys.stderr)
        if self.pending:
            print(f"sensord: waiting: {', '.join(self.pending)}", file=sys.stderr)

    def _on_call(self, conn, sender, path, iface, method, params, invocation):
        name = iface.rsplit(".", 1)[-1]
        if method == "GetReadings":
            invocation.return_value(GLib.Variant("(a{sd})", (self.readings.get(name, {}),)))
        else:
            invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)

    def _make_tick(self, name):
        def tick():
            r = self.sensors[name].sample()
            if r:
                self.readings[name] = r
                if self.bus:
                    self.bus.emit_signal(
                        None, DBUS_PATH, f"org.sensord.{name}", "Changed",
                        GLib.Variant.new_tuple(GLib.Variant("a{sd}", r)),
                    )
            return GLib.SOURCE_CONTINUE
        return tick

    def _make_probe(self, name):
        cls, interval = self.pending[name]
        def probe():
            sensor = cls()
            if not sensor.available:
                return GLib.SOURCE_CONTINUE
            self.sensors[name] = sensor
            self.readings[name] = {}
            del self.pending[name]
            print(f"sensord: late: {name}", file=sys.stderr)
            GLib.timeout_add_seconds(interval, self._make_tick(name))
            return GLib.SOURCE_REMOVE
        return probe

    def run(self):
        for name in self.sensors:
            GLib.timeout_add_seconds(SENSORS[name][1], self._make_tick(name))
        for name in list(self.pending):
            GLib.timeout_add_seconds(self.pending[name][1], self._make_probe(name))

        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 2, self.loop.quit)
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 15, self.loop.quit)
        self.loop.run()

        for s in self.sensors.values():
            s.close()


# ── entry ─────────────────────────────────────────────────────


def setup():
    with open(DBUS_CONF, "w") as f:
        f.write(POLICY)
    os.chmod(DBUS_CONF, 0o644)
    print(f"wrote {DBUS_CONF}", file=sys.stderr)


def main():
    if os.geteuid() != 0:
        print("run as root", file=sys.stderr)
        sys.exit(1)

    if "--setup" in sys.argv:
        setup()
        return

    Daemon().run()


if __name__ == "__main__":
    main()

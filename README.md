# signalk-waveshare-relays

A Signal K server plugin for the Waveshare **ESP32-S3-ETH-8DI-8RO** relay boards
(the `-C` cased version too) running **ESPHome** firmware with the `web_server` component.

- Switches the relays on one or more boards through standard Signal K PUT requests, so it works with KIP,
  WilhelmSK and any other app that can toggle `electrical.switches`.
- Updates state instantly from ESPHome's event stream, with periodic polling
  as a fallback.
- Can also publish the 8 digital inputs (off by default).
- Optional NMEA 2000 switch bank (PGN 127501 status and 127502 control), so N2K
  displays and keypads can switch the relays.

## Requirements

- Signal K server running on Node.js 18 or newer
- The board running ESPHome with `web_server:` enabled (v2 or v3), reachable from the
  Signal K server

## Signal K paths

| Path | Value | PUT |
|---|---|---|
| `electrical.switches.bank.<bankId>.<channel>.state` | relay state | yes |
| `electrical.digitalInputs.<bankId>.<channel>.state` | input state (optional) | no |

Each board has its own `bankId` (the default is `waveshare`). Values are `true`/`false` unless you set the
**State value format** option to `1 / 0`. A PUT accepts `true`/`false`, `1`/`0` or
`"on"`/`"off"`. Each path also gets a `displayName` in its meta, taken from the configuration.

## Configuration

Add one entry under **Boards** for each Waveshare board. Each board has its own
settings:

| Setting | Default | Notes |
|---|---|---|
| Enabled | on | Turn a board off without deleting its settings |
| Board address | *(required)* | IP address or hostname, e.g. `192.168.1.129` or `waveshare001.local` |
| Bank ID | `waveshare` | Must be different for each board, e.g. `fwd` and `aft` |
| Web server username / password | empty | Only if `auth:` is set under `web_server:` in ESPHome |
| Use event stream | on | Instant updates through ESPHome's `/events` |
| Poll interval | 10 s | Full refresh; `0` disables polling |
| Relays | `Relay 1` … `Relay 8` | Channel number, ESPHome switch name, display name |
| Publish digital inputs | off | |
| Digital inputs | `DI1` … `DI8` | Channel number, ESPHome binary_sensor name, display name |
| NMEA 2000 switch bank → Enable | off | |
| NMEA 2000 switch bank → Switch bank instance | 0 | 0–252; must be unique among switch banks on the bus |

These settings apply to all boards:

| Setting | Default | Notes |
|---|---|---|
| State value format | `true / false` | Or `1 / 0` |
| NMEA 2000 status interval | 5 s | How often 127501 repeats; it's also sent on every change |

If two boards share a bank ID, the second one isn't started. If two boards share an
N2K instance, the second one runs without N2K. Both cases, and any board that
can't be reached, show up in the plugin's status in the admin UI. The other boards
keep working.

The ESPHome entity names must match the `name:` values in the board's ESPHome YAML.
With the plugin's debug logging on, every entity on the board that isn't mapped is
logged once. That's a quick way to find the correct names.

## NMEA 2000

When enabled, the plugin uses the Signal K server's own NMEA 2000 connection
(for example a CAN HAT on `can0`, or an Actisense or Yacht Devices gateway) to
make the board appear as a binary switch bank:

- **PGN 127502 Switch Bank Control** with the configured instance switches the relays.
  Channels marked "no change" are left alone. Channel numbers are the ones in the
  Relays table (1–28).
- **PGN 127501 Binary Switch Bank Status** goes out on every change, in reply to
  every command, and every *NMEA 2000 status interval*. When the board can't be reached,
  every channel is reported as `Unavailable`.

Any N2K device that uses the standard 127501/127502 switching PGNs can control the
relays. Many MFD "digital switching" screens use proprietary systems instead
(CZone, EmpirBus and others) and won't see this bank. Check your display's
documentation.

If the Signal K server also reads the bus, it converts the bank's own 127501 into
`electrical.switches.bank.<instance>.*`. Don't set **Bank ID** to the same number
as the N2K instance, or the two sources will write to the same paths.

## Migrating from the Node-RED flow

This plugin replaces the "Waveshare Relays (HTTP)" Node-RED flow and uses the
same paths. **Disable that flow before enabling the plugin.** Otherwise both
register PUT handlers on the same paths and both poll the board.

## Development

```sh
npm test
```

The tests run against a mock ESPHome web server and need no hardware.

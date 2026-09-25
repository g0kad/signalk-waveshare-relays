# Changelog

## Plugin

### 0.1.0 (unreleased)

First public test release.

- Switch the relays on one or more Waveshare ESP32-S3-ETH-8DI-8RO boards running
  ESPHome through Signal K PUT requests, with live state from ESPHome's event
  stream and polling as a fallback.
- Optionally publish the 8 digital inputs.
- Optional NMEA 2000 binary switch bank (PGN 127501 status, 127502 control).
- Find boards running the prebuilt firmware on the network.
- Set and change the admin password stored on boards running the prebuilt firmware.

## Firmware

### 0.3.0

- mDNS discovery service (`_wsrelay._tcp`) so the plugin can find boards.
- Admin password stored on the board and set by the plugin. The LED pulses amber
  while the board has no password. Holding BOOT for 10 seconds clears it.

# SMS Bridge — companion app for the adb (UFI003S) modem

The `adb` modem driver sends SMS through Android's `isms` service, but the adb
shell only holds `SEND_SMS` — **not** `READ_SMS`/`RECEIVE_SMS` — so it can't read
the inbox, and the device has no headless USSD. This tiny helper app closes the
inbox gap: it declares the SMS permissions the shell lacks and writes results to
files under `/sdcard/smsbridge/` that the adb shell can read.

It targets `minSdk`/`targetSdk` 19 (KitKat), so its permissions are granted at
install with no runtime prompt. Built by hand (no gradle) — see `build.sh`.

## What it provides

| Capability | Mechanism | Status on the UFI003S |
|---|---|---|
| **Inbox capture** | `SmsReceiver` catches `SMS_RECEIVED` (delivered to any `RECEIVE_SMS` holder on KitKat, unlike `SMS_DELIVER`) and appends each message to `incoming.jsonl` | ✅ works |
| Inbox (stored) | `DUMP_INBOX` reads `content://sms/inbox` | ⚠️ empty — with no default SMS app, KitKat never writes received SMS to the provider; use the live capture above |
| **USSD** | `Ussd` dials via `ACTION_CALL`; `UssdAccessibilityService` screen-scrapes the reply dialog (the only way a non-system app reads it pre-API-26) | ❌ mechanism works, but this SIM registers **LTE-only, "CSS not supported"**, so the network releases every USSD session (`UNSOL_ON_USSD` mode 2). Radio limitation, not software |

The gateway's adb driver auto-drains `incoming.jsonl` in `getMessages()`; nothing
else needs wiring. Disable with `"smsBridge": false` on the modem's `MODEMS` entry.

## Build & install

```bash
./build.sh                                   # -> build/smsbridge.apk
adb -s <device> install -r build/smsbridge.apk
```

Requires a JDK and the Android SDK build-tools + a platform `android.jar`
(paths are set at the top of `build.sh`). The signing keystore (`debug.keystore`)
is created once and kept out of `build/` so rebuilds keep a stable cert (else
`adb install -r` fails with `INCONSISTENT_CERTIFICATES`).

## One-time device setup

After install, wake the app out of its post-install "stopped" state so the
`SmsReceiver` goes live (an explicit broadcast clears the stopped flag):

```bash
adb -s <device> shell "am broadcast -a com.gateway.smsbridge.DUMP_INBOX \
  -f 0x00000020 -n com.gateway.smsbridge/.BridgeReceiver"
```

USSD capture additionally needs the accessibility service enabled (works from
adb, no root) — only worth doing if the modem's network supports CS USSD:

```bash
adb -s <device> shell settings put secure enabled_accessibility_services \
  com.gateway.smsbridge/com.gateway.smsbridge.UssdAccessibilityService
adb -s <device> shell settings put secure accessibility_enabled 1
```

## Manual triggers (for debugging)

```bash
# dump content://sms/inbox -> /sdcard/smsbridge/inbox.json
adb shell "am broadcast -a com.gateway.smsbridge.DUMP_INBOX \
  -f 0x00000020 -n com.gateway.smsbridge/.BridgeReceiver"

# dial a USSD code -> reply captured to /sdcard/smsbridge/ussd.json
adb shell "am broadcast -a com.gateway.smsbridge.RUN_USSD \
  -f 0x00000020 -n com.gateway.smsbridge/.BridgeReceiver --es code '*222#'"
```

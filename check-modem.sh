#!/usr/bin/env bash
#
# check-modem.sh — verify ZTE HiLink / OLAX (zte-http driver) sticks are reachable
# over their USB network interface, without WiFi and without starting the gateway.
#
# It proves the transport the gateway relies on: USB stick -> virtual ethernet
# interface (RNDIS/CDC-ECM) -> HTTP API at the stick's gateway IP. If the API
# probe here passes, `npm start` will be able to talk to the modem.
#
# Usage:
#   ./check-modem.sh                 # probe modems from .env MODEMS (or built-in defaults)
#   ./check-modem.sh 192.168.0.1     # probe an explicit host (api auto: .1->goform guess)
#   ./check-modem.sh zte:192.168.0.1:goform olax:172.16.0.1:reqproc
#
# Exit code: 0 if every probed stick answered its API, non-zero otherwise.

set -u

# ---- pretty output ---------------------------------------------------------
if [ -t 1 ]; then
  R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; B=$'\e[36m'; D=$'\e[2m'; N=$'\e[0m'
else
  R=''; G=''; Y=''; B=''; D=''; N=''
fi
pass() { printf '  %s✔ PASS%s %s\n' "$G" "$N" "$1"; }
fail() { printf '  %sx FAIL%s %s\n' "$R" "$N" "$1"; }
warn() { printf '  %s! WARN%s %s\n' "$Y" "$N" "$1"; }
info() { printf '  %s·%s %s\n' "$D" "$N" "$1"; }
hdr()  { printf '\n%s== %s ==%s\n' "$B" "$1" "$N"; }

need() { command -v "$1" >/dev/null 2>&1; }

# ---- resolve the modem list ------------------------------------------------
# Each entry is "id:host:api". Sources, in order of precedence:
#   1) command-line args
#   2) MODEMS array in ./.env (parsed with node if available)
#   3) built-in defaults (this fleet's two sticks)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEMS_LIST=()

guess_api() { case "$1" in 172.16.*) echo reqproc;; *) echo goform;; esac; }

if [ "$#" -gt 0 ]; then
  for a in "$@"; do
    case "$a" in
      *:*:*) MODEMS_LIST+=("$a") ;;
      *:*)   MODEMS_LIST+=("$a:$(guess_api "${a#*:}")") ;;
      *)     MODEMS_LIST+=("stick:$a:$(guess_api "$a")") ;;
    esac
  done
elif [ -f "$SCRIPT_DIR/.env" ] && need node; then
  while IFS= read -r line; do
    [ -n "$line" ] && MODEMS_LIST+=("$line")
  done < <(node -e '
    require("fs");
    const env = require("fs").readFileSync(process.argv[1], "utf8");
    const m = env.match(/^\s*MODEMS\s*=\s*(.+)$/m);
    if (!m) process.exit(0);
    let raw = m[1].trim();
    if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'"'"'") && raw.endsWith("'"'"'")))
      raw = raw.slice(1, -1);
    let arr; try { arr = JSON.parse(raw); } catch { process.exit(0); }
    for (const e of arr) {
      if (e && e.driver === "zte-http" && e.host)
        console.log(`${e.id||"zte"}:${e.host}:${(e.api||"goform").toLowerCase()}`);
    }
  ' "$SCRIPT_DIR/.env" 2>/dev/null)
fi

if [ "${#MODEMS_LIST[@]}" -eq 0 ]; then
  info "No CLI args and no zte-http modems in .env — using built-in fleet defaults."
  MODEMS_LIST=("zte:192.168.0.1:goform" "olax:172.16.0.1:reqproc")
fi

# ---- host-level USB / kernel overview (informational) ----------------------
hdr "USB & kernel"
if need lsusb; then
  n=$(lsusb | grep -icE 'zte|olax|qualcomm|hisilicon|mobile|modem|rndis' || true)
  info "lsusb: $(lsusb | wc -l | tr -d ' ') USB devices, $n look modem-ish"
else
  warn "lsusb not found (apt install usbutils) — skipping USB device list"
fi

if need ip; then
  usbif=$(ip -o link show 2>/dev/null | grep -oE '(usb[0-9]+|enx[0-9a-f]{12})' | sort -u | tr '\n' ' ')
  [ -n "$usbif" ] && info "USB net interfaces: $usbif" || warn "No usb0/enx* interface found yet — is a stick plugged in and in RNDIS mode?"
else
  warn "'ip' not found — cannot inspect network interfaces"
fi

if need dmesg; then
  if dmesg 2>/dev/null | grep -qiE 'rndis_host|cdc_ether'; then
    info "dmesg shows rndis_host/cdc_ether bound — stick came up as a network device (good)"
  elif dmesg 2>/dev/null | grep -qiE 'usb-storage.*(zte|olax)|new .*storage'; then
    warn "A stick may be in USB-storage/CD-ROM mode — try: sudo usb_modeswitch ... (or enable HiLink/NDIS mode)"
  fi
fi

# ---- per-stick probe -------------------------------------------------------
CURL_TIMEOUT=5
overall=0

probe_one() {
  local id="$1" host="$2" api="$3"
  local base="http://$host" ok=1
  case "$api" in
    goform)  local getp="/goform/goform_get_cmd_process" ;;
    reqproc) local getp="/reqproc/proc_get" ;;
    *)       fail "$id: unknown api '$api' (use goform or reqproc)"; return 1 ;;
  esac

  hdr "$id  ($host, $api)"

  # 1) Is there a route to the host (i.e. the USB iface owns this subnet)?
  if need ip; then
    local dev
    dev=$(ip route get "$host" 2>/dev/null | grep -oE 'dev [^ ]+' | awk '{print $2}' | head -1)
    if [ -n "$dev" ]; then pass "route to $host via '$dev'"; else warn "no route to $host — interface for this subnet not up"; ok=0; fi
  fi

  # 2) TCP/HTTP reachability of the stick's web server
  if need curl; then
    if curl -s -o /dev/null -m "$CURL_TIMEOUT" "$base/"; then
      pass "HTTP reachable  $base/"
    else
      fail "no HTTP response from $base/ (stick unplugged, wrong IP, or wrong mode)"
      ok=0
    fi

    # 3) The actual gateway API endpoint — the definitive check.
    #    'signalbar' is a harmless read the web UI itself polls.
    local url="$base$getp?isTest=false&cmd=signalbar"
    local body
    body=$(curl -s -m "$CURL_TIMEOUT" -H "Referer: $base/index.html" -H "X-Requested-With: XMLHttpRequest" "$url" 2>/dev/null)
    if printf '%s' "$body" | grep -q '{'; then
      pass "API responded  ${D}$(printf '%s' "$body" | tr -d '\n' | cut -c1-60)${N}"
    else
      fail "API endpoint $getp gave no JSON — driver would fail here"
      [ -n "$body" ] && info "raw: $(printf '%s' "$body" | tr -d '\n' | cut -c1-80)"
      ok=0
    fi
  else
    fail "curl not found (apt install curl) — cannot probe $id"
    ok=0
  fi

  if [ "$ok" -eq 1 ]; then
    printf '  %s→ %s is READY for the gateway%s\n' "$G" "$id" "$N"
  else
    printf '  %s→ %s is NOT reachable — see failures above%s\n' "$R" "$id" "$N"
    overall=1
  fi
}

for entry in "${MODEMS_LIST[@]}"; do
  IFS=':' read -r id host api <<<"$entry"
  probe_one "$id" "$host" "$api"
done

hdr "Result"
if [ "$overall" -eq 0 ]; then
  printf '  %sAll probed sticks answered their API — transport is good, WiFi not needed.%s\n' "$G" "$N"
else
  printf '  %sOne or more sticks failed. Common fixes:%s\n' "$R" "$N"
  info "stick in storage/CD-ROM mode  -> sudo usb_modeswitch, or switch it to HiLink/NDIS mode"
  info "no interface / no route       -> replug; check 'ip addr'; RNDIS needs the rndis_host kernel module (native on Linux)"
  info "HTTP ok but API empty         -> wrong 'api' (goform vs reqproc) for this model"
fi
exit "$overall"

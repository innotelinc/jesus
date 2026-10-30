#!/usr/bin/env bash
# Do the seven names actually point at this box, over HTTPS, with a certificate a
# browser would accept?
#
# "It resolves" is not the question. A name can resolve to the right box and still
# answer a TLS alert because the certificate was never issued — Let's Encrypt only
# signs a name whose challenge it can reach, so a record pointing at the old
# server means the new one can never get a certificate however healthy it is.
#
#   ./deploy/domains.sh                  # ask the public DNS
#   ./deploy/domains.sh --ip 45.77.221.158   # ask that box directly, SNI intact
#
# The second form is the useful one while DNS is still moving: it proves the edge
# would serve each name the moment the records point at it, and it fails with the
# real reason (no certificate yet) rather than a timeout.
set -uo pipefail

DOMAINS=(telno.services telno.online telno.mobi telno.digital telno.tel telno.directory telno.network)
IP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --ip) IP="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

HOSTS="$(IFS=,; echo "${DOMAINS[*]}")" TARGET_IP="$IP" node -e '
const tls = require("tls"), https = require("https"), dns = require("dns").promises;
const hosts = process.env.HOSTS.split(",");
const pinned = process.env.TARGET_IP || "";

const one = (host) =>
  new Promise((resolve) => {
    const opts = { host: pinned || host, servername: host, port: 443, timeout: 12000 };
    const socket = tls.connect(opts, () => {
      const cert = socket.getPeerCertificate();
      const days = Math.round((Date.parse(cert.valid_to) - Date.now()) / 86400000);
      // A valid chain is only half of it: the box has to be the one this name is
      // meant for, which is why the address is reported next to the certificate.
      https
        .get({ ...opts, path: "/", headers: { host }, rejectUnauthorized: true }, (res) => {
          res.resume();
          resolve({ host, ok: true, status: res.statusCode, cn: cert.subject?.CN, issuer: cert.issuer?.O, days, addr: res.socket.remoteAddress });
          socket.destroy();
        })
        .on("error", () => resolve({ host, ok: true, status: "-", cn: cert.subject?.CN, issuer: cert.issuer?.O, days, addr: socket.remoteAddress }));
    });
    socket.on("error", (err) => resolve({ host, ok: false, error: err.code || err.message }));
    socket.setTimeout(12000, () => { socket.destroy(); resolve({ host, ok: false, error: "timeout" }); });
  });

(async () => {
  let bad = 0;
  for (const host of hosts) {
    let where = pinned;
    if (!where) {
      try { where = (await dns.resolve4(host))[0]; } catch (err) { where = err.code; }
    }
    const r = await one(host);
    if (!r.ok) {
      bad += 1;
      console.log(`${host.padEnd(17)} ${String(where).padEnd(16)} FAIL  ${r.error}`);
      continue;
    }
    const warn = r.days < 21 ? ` (expires in ${r.days}d)` : "";
    console.log(`${host.padEnd(17)} ${String(where).padEnd(16)} ${String(r.status).padEnd(4)} ${r.issuer} ${r.cn}${warn}`);
  }
  process.exit(bad ? 1 : 0);
})();
'

# Reaching your Mac from your phone (privately)

Default: the control plane listens on `127.0.0.1:8787` only. Nothing is exposed until you choose
one of the options below. **Never forward a router port to it**, and never expose the Hermes API
server (port 8642) beyond loopback; the phone talks only to the control plane.

## Option A — Tailscale (recommended)

Tailscale puts your Mac and phone on a private WireGuard network ("tailnet"). This repo's sibling
`Ai-platform` already uses the same approach.

1. Install Tailscale on the Mac and the phone from tailscale.com / the App Store, and sign in to
   the same account. (Review installers yourself; this project does not install anything.)
2. Find the Mac's tailnet address: `tailscale ip -4` (a `100.x.y.z` address) or its MagicDNS name.
3. Bind the control plane to that address only, and declare the origin the phone will use:

   ```bash
   HDW_HOST=100.x.y.z
   HDW_PUBLIC_ORIGIN=http://100.x.y.z:8787     # or http://<mac-name>.<tailnet>.ts.net:8787
   ```

4. `npm start`, then open the origin on the phone, pair with the code from the Mac terminal, and
   "Add to Home Screen" to install the PWA.

Traffic is encrypted by WireGuard even though the URL is `http://`. Browsers treat a non-HTTPS,
non-localhost origin as insecure, so the service worker (offline shell) will not register and
cookies are not marked `Secure`; the app works otherwise.

**HTTPS on the tailnet (unverified in this session).** Tailscale offers `tailscale serve` to proxy a
local port over HTTPS with a `*.ts.net` certificate to tailnet devices only. Its CLI syntax has
changed between versions and could not be checked here (tailscale.com was unreachable from this
build environment). If you use it: keep `HDW_HOST=127.0.0.1`, point `serve` at
`http://127.0.0.1:8787`, set `HDW_PUBLIC_ORIGIN=https://<mac-name>.<tailnet>.ts.net`, and make sure
you are using **serve (tailnet-only), not funnel (public internet)**. Check
`tailscale serve --help` and the official docs for your installed version.

## Option B — same Wi-Fi, temporarily

`HDW_HOST=<Mac LAN IP>` and `HDW_PUBLIC_ORIGIN=http://<Mac LAN IP>:8787`. Anyone on that network can
reach the login screen (pairing and sessions still apply). Prefer Option A.

## When the Mac sleeps or goes offline

The app shows **CACHED**, a red/amber status, and the time of the last confirmed update. Nothing
runs on the phone. Hermes runs continue on the Mac if it is awake; the control plane reconciles
them on restart. To keep it available, prevent sleep (System Settings → Energy/Battery) and run the
control plane as a login service (a `launchd` plist is a next milestone; `Ai-platform/scripts/mac-service.sh`
shows the pattern).

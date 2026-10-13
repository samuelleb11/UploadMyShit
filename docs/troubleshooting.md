# Troubleshooting

Start with **Settings → Diagnostics** on the devices involved. It shows:
- the page and server versions;
- the room;
- how each connection travels and why;
- every lane's rate;
- what a running transfer is waiting for.

**Run network test** shows what STUN and TURN find from that device, and says whether a
direct connection across the internet can work from there. **Copy report** puts all of it
on the clipboard. The report contains IP addresses, so mind where you paste it.

- [Devices from other networks appear in "Your network"](#devices-from-other-networks-appear-in-your-network)
- [Devices on the same network don't see each other](#devices-on-the-same-network-dont-see-each-other)
- [The room says "Not in a room"](#the-room-says-not-in-a-room)
- [A transfer fails with "Name is not allowed"](#a-transfer-fails-with-name-is-not-allowed)
- [A device is marked "outdated, reload it"](#a-device-is-marked-outdated-reload-it)
- [The page still shows the old version after a deploy](#the-page-still-shows-the-old-version-after-a-deploy)
- [Devices connect, but slowly, over the internet](#devices-connect-but-slowly-over-the-internet)
- [Two devices can't connect at all](#two-devices-cant-connect-at-all)
- [A transfer fails with "the other device stopped responding"](#a-transfer-fails-with-the-other-device-stopped-responding)
- [Transfers are slower than expected on a fast network](#transfers-are-slower-than-expected-on-a-fast-network)
- [Files download one by one instead of going into a folder](#files-download-one-by-one-instead-of-going-into-a-folder)
- [Some files didn't arrive, or arrived renamed](#some-files-didnt-arrive-or-arrived-renamed)

## Devices from other networks appear in "Your network"

The server is attributing one address to visitors from different networks. There are two
possible causes.

**A proxy in front hides visitors' addresses.** This is the case when people on different
home or office networks all see each other. Every visitor appears to come from the
proxy's address.
- **Behind Cloudflare** (proxied DNS or a Tunnel): set `UMS_CLIENT_IP_HEADER=cf-connecting-ip`
  (chart: `server.clientIpHeader`). Current versions detect this case on their own. They
  then keep visitors out of network rooms and log a warning beginning "visitors come
  through Cloudflare".
- **Behind another proxy**, the proxy must see visitors' real addresses and pass them in
  `X-Forwarded-For`. See
  [Visitor addresses](deployment.md#visitor-addresses-and-network-rooms).
- Until it's fixed, `UMS_NETWORK_ROOMS=false` leaves only private rooms.

**Carrier-grade NAT.** If only devices on mobile data see strangers, their carrier shares
one public IPv4 address among many customers. Network rooms can't tell those customers
apart, and ShareDrop has the same limit. Use a private room, or turn network rooms off.

## Devices on the same network don't see each other

- **One is on IPv6 and the other on IPv4.** Their public addresses differ, so their rooms
  differ. Diagnostics shows each device's room.
- **A VPN** on one device gives it another public address.
- **Network rooms are off, or the address is unknown.** See the next section.

Whatever the cause, a private room always works: click **New room** and open the link on
the other device, or scan its QR code.

## The room says "Not in a room"

The device is in no network room, for one of two reasons:
- **Network rooms are turned off** (`UMS_NETWORK_ROOMS=false`). Diagnostics shows the room
  as `none`.
- **The server can't see the visitor's real address**, behind Cloudflare with the wrong
  header. Diagnostics shows the room as `address-unknown`, and the server's log has the
  warning. See [above](#devices-from-other-networks-appear-in-your-network).

## A transfer fails with "Name is not allowed"

The receiving Chrome refused a file name in the chosen folder. Current versions clean
names on both sides, using the rules Chrome itself applies, so this means the receiving
tab runs an old page. Reload it. Its device shows as **outdated, reload it** on the
others.

The error names the file. If a current page on both sides still fails on a name, please
report the name. The rules were measured against real Chrome, and
[development.md](development.md#measuring-chromes-name-rules) explains how to measure a
new case.

## A device is marked "outdated, reload it"

That device's page is older than the one the server serves now. Reload it there. Tabs
normally reload themselves once their transfers finish. A device marked outdated hasn't
done so yet, or its page is too old to know how.

## The page still shows the old version after a deploy

The footer shows the version the page runs. If it lags, a cache in front is serving the
old page. With Cloudflare, set Caching → Configuration → Browser Cache TTL to **Respect
Existing Headers**. Its default rewrites the page's `no-cache` to several hours. Open tabs
reload themselves once they reconnect to the new server either way.

## Devices connect, but slowly, over the internet

Check the route in Diagnostics:
- **"Through TURN"** means there is no direct path. TURN services vary widely in speed.
  Deploy the [relay Worker](../worker/README.md): when a relay is configured, a connection
  that lands on TURN hands its data to the relay at once.
- **"Direct"** over a long distance is limited by the slower of the two connections, and
  by Chrome's WebRTC ceiling (see
  [below](#transfers-are-slower-than-expected-on-a-fast-network)). With a relay and the
  speed-up setting on, large transfers add relay lanes when that's faster.

## Two devices can't connect at all

Their networks allow no direct path: symmetric NAT on both sides, or UDP blocked. A relay
fixes this.
- **Without a relay or TURN**, such pairs can't connect. Deploy the relay. In that case
  Diagnostics shows "Relay: not configured", and the network test finds no TURN
  candidate.
- **With a relay**, the page switches to it after about 4 seconds without a direct
  connection. If that fails too, check that the server's `UMS_RELAY_SECRET` matches the
  Worker's `RELAY_SECRET`. The Worker answers `403` to a ticket signed with another
  secret, which shows in the browser's console as a failed WebSocket to the Worker.

## A transfer fails with "the other device stopped responding"

Nothing arrived from the other device for 45 seconds. It slept, lost its network, or its
tab was closed. Send again. A lane that stops delivering while others still work doesn't
cause this: it is dropped after 8 seconds, and what it held is sent again on the others.

## Transfers are slower than expected on a fast network

Chrome's WebRTC data channels top out at roughly 30–45 MB/s per browser pair, whatever
the network. Each packet crosses between Chrome's processes on its own. Things to check:
- **Upload speed limit** in Settings: 0 means none.
- **Parallel connections:** Automatic adds connections only while each one raises the
  rate.
- **The transfer's wait breakdown** in Diagnostics, under "Sending now". It shows whether
  the sender waits on its lanes, the receiver's window (a slow disk on the receiving
  side), its own disk, or the limit.
- **A relay**, which doesn't share Chrome's WebRTC ceiling. With the speed-up setting on,
  large transfers add relay lanes when they help.

## Files download one by one instead of going into a folder

The receiving browser has no folder access: Firefox, Safari, anything on iOS, or Chrome
on Android. Each file is saved as a download as soon as it is complete. Only Chrome on a
computer can stream into a folder. The page must also be served over `https://`; browsers
deny folder access on insecure pages.

## Some files didn't arrive, or arrived renamed

Both are deliberate.
- **System files are left out by the sender**, which shows a note listing them:
  `Thumbs.db`, `desktop.ini`, `.DS_Store`, `._` sidecars, Office lock files, `$RECYCLE.BIN`,
  `__MACOSX` and the like. See [architecture.md](architecture.md#names-and-os-clutter).
- **Names the receiving Chrome wouldn't store are cleaned.** A refused character becomes
  `_`; trailing dots and spaces go; a reserved name such as `con.txt` gets a leading `_`;
  a `.lnk`/`.url` shortcut gets a trailing `_`.
- **Existing files in the destination are never overwritten.** A clash arrives as
  `name (2)`.

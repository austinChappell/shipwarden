# ShipWarden push relay

The push relay sends the push notifications of ShipWarden to the iPhone app. Apple sends a notification to an iPhone
only from a server with the APNs key of the app. ShipWarden runs on your Mac, so this small server holds the key.

The relay keeps no data. It has no database and writes no files. It does not see agent text. Each notification has
only a fixed title ("Agent needs input", "Automation is waiting for approval", or "Notifications work"), the name of
the worktree, and the IDs that open the agent on a tap.

> **Status.** Nobody deployed a relay yet. The default relay address in ShipWarden is a placeholder
> (`https://shipwarden-relay.invalid`). ShipWarden sends no notifications until you type the address of your relay in
> Settings › Mobile.

## How it works

```
iPhone ──(1) device token──▶ relay ──▶ ticket + push key ──▶ iPhone
iPhone ──(2) ticket + push key, over the paired HTTPS connection──▶ Mac
Mac    ──(3) signed push: ticket, kind, worktree name, IDs──▶ relay ──▶ APNs ──▶ iPhone
```

1. The iPhone app gets its APNs device token from iOS. It sends the token to `POST /v1/register`. The relay encrypts
   the token into a **ticket** (AES-256-GCM, with a key from `RELAY_SECRET`) and returns the ticket and a **push key**.
   The push key is an HMAC of the ticket. Only the relay can make it.
2. The phone gives the ticket and the push key to its paired Mac (`POST /v1/push/register` of the Mac). The Mac
   keeps them in `remote-devices.json` (mode 0600). The Mac never sees the device token.
3. When an agent needs input, the Mac sends `POST /v1/push` with the ticket, the kind, the worktree name, and the
   agent ID. It signs `<unix time>.<body>` with HMAC-SHA256 and the push key. The relay checks the signature and the
   time (at most 5 minutes off), opens the ticket, makes the notification text itself, and sends it to APNs.

### Protection against abuse

- A Mac can push only to the phones that gave it a ticket. Without the push key of a ticket, the relay refuses the
  request (401). A changed body or an old request also gets 401.
- The Mac cannot send its own text. The relay makes the title from the kind, and it accepts only a short worktree name
  (100 characters) and IDs of letters, digits, `-`, `_`, and `.`.
- The relay limits the pushes of each ticket (120 in one hour) and the registrations of each address (30 in one hour).
  The counts are only in memory. A restart clears them.
- A request that replays a signed request in the 5 minutes sends the same notification again. It cannot change it.
- Anyone who has a device token of the app can register it. A device token is known only to the phone and Apple, and
  Apple shows a notification only for the app of the key. App Attest can make this stricter later.
- A new `RELAY_SECRET` makes all tickets invalid. The phones register again at their next connection.

## Configuration

The relay reads these environment variables:

| Variable                | Value                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `RELAY_SECRET`          | A random secret of at least 32 characters, for example from `openssl rand -hex 32`. Keep it the same across deploys. |
| `APNS_TEAM_ID`          | The Team ID of the Apple developer account (10 characters).                                                          |
| `APNS_KEY_ID`           | The Key ID of the APNs key.                                                                                          |
| `APNS_PRIVATE_KEY`      | The content of the `.p8` file. You can write the line breaks as `\n`.                                                |
| `APNS_PRIVATE_KEY_FILE` | The path of the `.p8` file. Use it instead of `APNS_PRIVATE_KEY`.                                                    |
| `APNS_TOPIC`            | The bundle ID of the iPhone app. Default: `dev.shipwarden.ios`.                                                      |
| `PORT`                  | The HTTP port. Default: `8787`.                                                                                      |
| `TRUST_PROXY`           | `1` when a proxy sets `X-Forwarded-For`. The rate limit of the registrations then uses that address.                 |

The relay itself speaks plain HTTP. Put it behind HTTPS: the TLS proxy of your host, or a reverse proxy such as Caddy.
ShipWarden accepts only an `https://` relay address (except `http://localhost`, for a test).

## Make the APNs key

1. Open [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/authkeys/list) of the
   Apple developer account that signs the iPhone app.
2. Add a key with **Apple Push Notifications service (APNs)** on. Download the `.p8` file. Apple lets you download it
   only one time.
3. Write down the Key ID and the Team ID.
4. In the identifier of the app (`dev.shipwarden.ios`), turn on **Push Notifications**.

One token-based key works for the sandbox and for production. The phone tells the relay its environment: a build from
Xcode uses the sandbox, and TestFlight and the App Store use production.

## Deploy

The relay needs Node 24 or later and no packages. Node runs the TypeScript files directly. The relay must keep a
connection to APNs over HTTP/2, so use a host that runs a normal Node process. The fetch of Cloudflare Workers and
other edge runtimes possibly does not use HTTP/2 to APNs, so we did not select them. `src/relay.ts` uses only Web
Crypto, so a Worker version needs only a new `server.ts` if this works later.

### Docker (Fly.io, Render, Railway, or a small VM)

```sh
cd relay
docker build -t shipwarden-relay .
docker run -p 8787:8787 \
  -e RELAY_SECRET="$(openssl rand -hex 32)" \
  -e APNS_TEAM_ID=ABCDE12345 \
  -e APNS_KEY_ID=XYZ987WVUT \
  -e APNS_PRIVATE_KEY="$(cat AuthKey_XYZ987WVUT.p8)" \
  shipwarden-relay
```

For example on Fly.io: `fly launch --no-deploy` in `relay/`, then `fly secrets set RELAY_SECRET=… APNS_TEAM_ID=…
APNS_KEY_ID=… APNS_PRIVATE_KEY="$(cat AuthKey.p8)"`, then `fly deploy`. Fly.io gives HTTPS on `https://<app>.fly.dev`.
One machine is enough. The relay needs no volume.

### Node without Docker

```sh
cd relay
RELAY_SECRET=… APNS_TEAM_ID=… APNS_KEY_ID=… APNS_PRIVATE_KEY_FILE=/etc/shipwarden/AuthKey.p8 npm start
```

### Check the deploy

```sh
curl https://relay.example.com/health
# {"ok":true,"version":1}
```

Then, in ShipWarden on the Mac:

1. Open Settings › Mobile. Turn on **Send push notifications**.
2. Type the relay address in **Relay address**, for example `https://relay.example.com`.
3. Open the iPhone app. It asks for permission to show notifications. Allow it.
4. Select **Send test** in Settings › Mobile. The phone shows "Notifications work".

## API

| Request             | Body                                                                                                                                                              | Answer                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /health`       |                                                                                                                                                                   | `{ "ok": true, "version": 1 }`                                                                        |
| `POST /v1/register` | `{ "deviceToken": "<hex>", "environment": "sandbox" \| "production" }`                                                                                            | `{ "ticket": "v1.…", "key": "<base64url>" }`                                                          |
| `POST /v1/push`     | `{ "ticket", "kind": "needsInput" \| "approval" \| "test", "worktree"?, "agentId"?, "runId"? }` with the headers `x-shipwarden-time` and `x-shipwarden-signature` | `{}`, or `410` when the phone does not accept notifications anymore. The Mac then forgets the ticket. |

The other errors are `400` (a value that is not valid), `401` (no signature, a wrong signature, or a wrong time), `403`
(a ticket of a different secret), `429` (the rate limit), and `502` (APNs refused the notification).

## Code and tests

| File                | Contents                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/relay.ts`      | The tickets, the signatures, the APNs payload, the provider token (ES256), and the rate limits. It uses only Web Crypto. |
| `src/server.ts`     | The Node HTTP server and the HTTP/2 connection to APNs.                                                                  |
| `src/relay.test.ts` | Tests without network. They also check the client of the Mac (`src/main/push/relay-client.ts`).                          |

Run the tests from the repository root with `npm test`. `npm run typecheck` also checks the relay.

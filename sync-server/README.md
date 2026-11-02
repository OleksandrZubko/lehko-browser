# Легко Sync server

Cloudflare Worker with one SQLite Durable Object per account. It stores encrypted records. For accounts without Google sign-in it never sees URLs, titles, folder names or keys.

## Deploy

```sh
cd sync-server
npm install
npx wrangler login
npx wrangler secret put INVITE_CODE   # new accounts need this code; existing accounts do not
npx wrangler deploy
```

Enter the printed `https://…workers.dev` address in the extension: **Синхронізація → Створити ланцюжок**.

## Local run

```sh
printf 'INVITE_CODE=local-dev-invite\n' > .dev.vars
npm run dev
```

From the repository root, `npm run test:sync` starts this server itself and syncs two real browser profiles through it.

## What the server sees

- A public key, whose hash is the account id.
- With Google sign-in: the ID token during the request, including the e-mail, but only a hash of the Google subject and the account key are stored.
- For each record: a keyed-hash id, an HLC (device id and time of change), a deleted flag, and ciphertext padded to 256-byte buckets.
- Timing and volume of requests, and client IP addresses as any Worker does.

## Security limits of this phase

- Every device holds the same account secret, in `chrome.storage.local`, readable by any process of the same macOS user. This phase therefore carries no passwords.
- There is no per-device revocation. If a device is lost, use **Видалити дані з сервера** on another device, then create a new chain and pair the rest again.
- A malicious server cannot read or forge records, but it can withhold updates or serve an old state.
- Invite codes gate account creation only. Add a Cloudflare rate-limiting rule before opening this to other people.

## Google sign-in

Google sign-in is the only lock. The server stores each Google account's secret and hands it to every sign-in of that account, so no phrase or code is needed. This trades end-to-end encryption away for those accounts: whoever controls the Google account, or the Cloudflare account running this Worker, can read their folders and tab URLs. Use two-factor sign-in on both, and do not offer this to other people as is. Invite and pairing accounts stay end-to-end encrypted until they are linked to Google.

1. In Google Cloud Console, create an OAuth client of type **Web application** with the redirect URI `https://<worker>/v1/google/callback`. No client secret is used. On the consent screen, keep the `openid` and `email` scopes and add yourself as a test user.
2. Set `GOOGLE_CLIENT_ID` in `[vars]` of `wrangler.toml`.
3. Run `npx wrangler secret put GOOGLE_ALLOWED_EMAILS` with a comma-separated list, then `npx wrangler deploy`.

Without both values, sign-in is refused. An allowed Google account may also create a new account in place of the invite code.

## API

- `POST /v1/sync` signed, `{cursor, changes[]}`: commits, then returns the next page.
- `POST /v1/wipe` signed: deletes the account.
- `GET /v1/google/start?redirect=…`, `POST /v1/google/callback`: sign-in redirects; the ID token reaches only the extension.
- `POST /v1/identity` with a Google ID token, `{op: claim, secret}`: stores the secret unless one exists, and returns the stored one. `{op: delete}` removes it. `{op: get|put, blob}` serve builds that still wrap the key with a passphrase.
- `PUT /v1/pair/:channel` signed, `GET /v1/pair/:channel`: one-time mailbox for the sealed account secret, 10-minute TTL.

# Trinum

A dark, English-language, mobile-first private messenger. Uses Node.js 22+ and browser APIs; no npm packages are needed.

## Start locally

```sh
npm start
```

Open **http://localhost:3000**. Apache/XAMPP alone does not run the Node server. The first screen is login, with a registration tab. Existing valid sessions return to the app automatically.

For a two-person test, use two separate browser profiles or one normal and one private window. Create two accounts, search for the other person's name or `@username`, send a friend invitation, then accept it in **Requests** on the recipient's account. Friends can accept or decline invitations even if the sender has gone offline. Both people must be online to exchange messages.

## Features

- Password login, unique usernames, persistent friendships and pending invitations.
- Passwords hashed with salted scrypt; random sessions in HttpOnly, SameSite=Strict cookies.
- Search registered users by display name or username, including offline users.
- Real-time online friends, invitation badges, accept/decline and request status.
- WebRTC encrypted peer messaging and typing indicators. Up to 500 messages per conversation held in browser memory.
- Mobile bottom navigation, full-screen conversations, back navigation, safe-area spacing and keyboard viewport handling.
- No message persistence, no message API, no message backups or server message history. Refreshing a tab clears its messages. The recipient's separate tab keeps its own messages until that tab is refreshed or closed.
- One active browser session per account. Logging in elsewhere revokes the previous session. Opening a second tab transfers the live session to that tab.

## Data

Voice messages: tap the microphone in a connected chat, record up to 60 seconds, stop to preview, then send or discard. Browser microphone permission and HTTPS (or localhost) are required. Audio is chunked over the encrypted WebRTC data channel and never sent to the server. Clips are capped at 1 MB, pending transfers time out, and each conversation retains at most 16 MB of voice audio in memory. Leaving a conversation, signing out or using Emergency exit stops recording; refreshing clears voice messages. Playback format support depends on the recipient's browser.

An always-visible red **Emergency exit** button is available while signed in, including within profile/privacy/security dialogs. One click immediately clears the local interface and connections and replaces the current tab with `https://www.temu.com/`, without waiting for a server response. A same-origin beacon (with keepalive fetch fallback) revokes the server session and **locks the account**: it cannot sign in again, even with the correct password, until an admin opens it in `/admin` → Manage → **Reactivate account**. The account, friends and payments are kept; nothing is deleted. The main admin set by `ADMIN_USERNAME` is only signed out, never locked. A local sign-out marker, cross-tab broadcast and back/forward-cache reload prevent automatic access on return. Server revocation still requires successful network delivery; immediate redirection cannot guarantee delivery while offline. Accounts that were waiting for the old 30-minute deletion are locked instead when the server starts.

Users can upload an avatar from Profile (JPG/PNG/WebP up to 5 MB). The browser center-crops and re-encodes it to a 256×256 JPEG, stripping source metadata; the server limits the saved image to 64 KB. Avatar images are served only to signed-in users. Remove an avatar from the same panel.

Registration needs only a name, username and any password. The emergency password is optional at registration (and can be set later); if one is entered it must be repeated, acknowledged and differ from the normal password, because otherwise every normal sign-in would lock the account. Profile → Emergency password allows changing or disabling the emergency credential after confirming the normal password; it must differ from the normal password. Entering it at normal sign-in signs out every session and locks the account exactly like Emergency exit; only an admin can reactivate it. There is no confirmation at sign-in. Older accounts have this feature disabled until configured; no default emergency passwords are assigned.

The server stores only account details, password salts/hashes, friend IDs and pending requests in `.data/accounts.json`, using atomic file replacement. Keep this private file out of source control. The Node server serves only an explicit asset allowlist, and Apache `.htaccess` rules also deny account-file access. No message text or WebRTC negotiation data is written to this file. Temporary session cookies and signaling connections live in server memory; a server restart requires users to log in again.

## Public deployment

Deploy the Node process behind HTTPS, preserve the public Host header and disable proxy buffering for `/api/events`. Set `COOKIE_SECURE=1` behind your HTTPS proxy. Serve this app at the domain root, or configure your proxy accordingly; the frontend uses root-relative API paths.

For reliable mobile connections across restrictive networks, add an authenticated TURN service to the `iceServers` configuration in `app.js`. The included public STUN service alone cannot connect every NAT/firewall combination. WebRTC can reveal a peer's IP address, and the STUN provider sees connection metadata. Invite only people you know.

Messages use WebRTC DTLS encryption. Identity depends on the signaling server: this version has no independent key verification and has not undergone a security audit. Recipients can copy messages or take screenshots. Account recovery, email verification and offline message delivery are not implemented.

## Verification

```sh
npm test
node --check server.js
node --check app.js
npm run test:browser
```

The browser check uses an existing local Chromium installation with no testing dependencies. Set `CHROME_PATH` to its executable if needed. It creates temporary accounts outside the app's real data directory, tests two independent browser contexts and saves screenshots in `.artifacts/`. Covers registration/login, search, invitations, online friends, bidirectional WebRTC messages, mobile back navigation, reduced keyboard viewport, persistence and widths 320/360/390/430/768/1440. The server tests also cover rejected invitations and blocked unauthorized signaling.

## Render

`render.yaml` deploys the app as a Render web service (Blueprint). Render provides HTTPS, sets `PORT`, and `COOKIE_SECURE=1` is preset. On the free plan the filesystem is ephemeral and the service sleeps when idle: accounts in `.data/accounts.json` are lost on every restart or redeploy. For persistent accounts, use a paid instance with a persistent disk and set `DATA_DIR` to the disk's mount path (e.g. `/var/data`).

## Subscriptions and admin panel

Passwords have no strength rules: any non-empty password (up to 1024 characters) is accepted, including very weak ones.

Access costs **$199 per month** (`PLAN_PRICE`). New accounts start as **pending** and see an activation page until an administrator records a payment. Subscriptions **expire automatically** at their end date: the user's open tabs lock immediately and friends can no longer start chats with them. Renewing adds time to the remaining period (or starts from today if expired). Statuses: `pending`, `active`, `expired`, `suspended`, `admin`.

The admin panel is at **`/admin`**. Set `ADMIN_PASSWORD` (and optionally `ADMIN_USERNAME`, default `admin`) in the server environment; the account is created or its password updated at every start. The panel shows revenue and user statistics, a searchable/sortable user list with status filters, one-click "+1 month · $199" renewals, custom periods and amounts, manual expiry dates, expire-now, notes, password resets, sign-out everywhere, suspension, admin roles, account deletion, payment history with removal, new-user creation and CSV exports. Payments are recorded manually by the administrator; no card processor is connected.

## Voice and video calls

The phone and camera buttons in a chat header start a voice or video call with a friend who is online. The friend sees a full-screen incoming call with Accept and Decline (and a ringtone); unanswered calls stop after 45 seconds and show as a missed call in the conversation. During a call you can mute, turn the camera off, switch between front and back camera on phones, and hang up. Audio and video travel directly between the two browsers over WebRTC (encrypted with DTLS-SRTP); the server only passes the call signals and never sees the media. The Emergency exit bar stays visible during a call and ends it.

Strict networks (some mobile carriers, corporate Wi-Fi) can block direct connections. For those, run a TURN relay such as coturn with `use-auth-secret` and set `TURN_URLS` (comma-separated, for example `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349`) and `TURN_SECRET`; Trinum then hands browsers short-lived TURN credentials from `/api/ice`.

## Offline delivery

Messages and voice messages can be sent at any time. While a direct WebRTC channel is open they travel peer to peer. Otherwise they go through the server: they are held in `mail.json` (next to `accounts.json`) only until the recipient's browser receives and acknowledges them, then deleted. The recipient gets them live if Trinum is open, or the next time they open it. Undelivered messages are readable by the server operator while they wait; they are not end-to-end encrypted. Messages are only accepted between friends.

## Screenshot protection

A web page cannot stop the operating system from taking a screenshot, so Trinum makes captures useless instead. The conversation is blurred behind a "Hidden for privacy" screen when:
- the page is hidden or loses focus (this also covers the Windows Snipping Tool and phone app-switcher previews);
- a screenshot shortcut is held (Win+Shift / Cmd+Shift);
- PrintScreen is pressed (the clipboard is also overwritten).

Printing, saving the page, the context menu, copying messages and dragging images are disabled. The emergency exit bar always stays visible. Screenshots taken with a phone's hardware buttons cannot be detected by a website.

## Voice changer

In the profile ("Your voice in calls and voice messages") or with the voice button during a call, each user picks Normal, Deep, Female or Child. The microphone runs through a real-time pitch shifter (`voice-fx.js`, an AudioWorklet; all voices use pitch-synchronous overlap-add, so they sound natural, without a sped-up or metallic sound) before it reaches the call or a voice message, so the other person only hears the changed voice. The choice is remembered on that device; "Test my voice" records three seconds and plays them back.

## Face privacy in video calls

In the profile ("Your face in video calls") or with the face button during a call, each user picks Normal, Mask or Blur face.

- Mask puts the Anonymous mask (`assets/mask-anonymous.webp`, supplied by the owner) over the whole face; it sits on the detected eyes, tilts with the head and is scaled to reach past the forehead, chin and cheeks. The white around the image is removed and everything inside it is made opaque.
- With Mask or Blur face, the camera is never sent directly: each frame is drawn on a canvas, the face is found with MediaPipe's face detector (BlazeFace short range) and covered before the frame leaves the device. Your own preview shows exactly what the other person sees.
- It fails closed: until the detector has loaded, and whenever no face is found for 300 ms, the whole picture is pixelated.
- The detector is served by Trinum itself from `vendor/mediapipe`, downloaded at build time by `scripts/fetch-vendor.js` with pinned SHA-256 checksums (run it once locally before `npm start`). The CSP allows `'wasm-unsafe-eval'` for it.
- The short-range model works best within about 2 metres of the camera. A face that is far away or mostly turned away may not be found; if no other face is found, the whole picture is hidden.

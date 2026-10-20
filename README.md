# Mobile as Cursor

Mobile as Cursor turns a smartphone browser into a wireless touchpad for a Windows PC.

## What is included

- **Premium Next.js UI**
  - Futuristic black welcome page (`/`)
  - Desktop dashboard with live pairing status and QR (`/dashboard`)
  - Settings panel (`/settings`)
  - Mobile remote touchpad (`/remote`)
- **Local desktop companion** (`companion/`)
  - Local HTTP API + WebSocket server
  - QR token pairing lifecycle with approval/reject flow
  - One authorized controller at a time
  - Heartbeat timeout and forced button release on disconnect
  - Windows-native input injection (mouse, click, scroll, maximize, restore, zoom shortcuts) via PowerShell + User32

## Architecture

1. Open dashboard on desktop: `http://<computer>:3000/dashboard`
2. Dashboard requests a short-lived pairing token from companion (`http://127.0.0.1:4850`).
3. Companion returns smartphone URL containing token and local LAN host.
4. Smartphone scans QR and opens `/remote?...` in browser.
5. Mobile sends `pair_request` over WebSocket.
6. Desktop user approves request in dashboard.
7. Companion accepts authenticated command messages (`mouse_move`, `left_click`, `right_click`, `scroll`, `drag_start`, `drag_end`, `maximize_window`, `zoom_in`, etc).

## Install

```bash
npm install
```

## Development

Run the Next.js UI:

```bash
npm run dev
```

Run companion in another terminal:

```bash
npm run companion:dev
```

By default:

- Next app web UI: `http://localhost:3000`
- Companion API + WS: `http://localhost:4850` and `ws://<LAN-IP>:4850/ws`

## Production build

```bash
npm run build
npm run companion:build
npm run companion:start
```

## Package Windows companion executable

```bash
npm run companion:package-win
```

Output: `dist/mobile-as-cursor-companion.exe`

> Note: Packaging native behavior should be validated on a real Windows 11 machine.

## Security model

- Pairing token is random and short-lived
- Pairing must be approved on desktop dashboard
- Only one mobile device can control at a time
- Commands are schema validated with zod
- Unauthorized or expired sessions are rejected
- Heartbeat timeout auto-disconnects and releases mouse button state
- No cloud dependency; all traffic is local network only

## Supported command set

- `mouse_move` (relative)
- `left_click`, `right_click`, `double_click`
- `scroll`
- `drag_start`, `drag_end`
- `maximize_window`, `restore_window`
- `zoom_in`, `zoom_out`, `reset_zoom`
- `heartbeat`, `disconnect`

## Windows behavior notes

- Native mouse and window commands execute on **Windows**.
- If target app is elevated (UAC/admin) and companion is not elevated, Windows may block injected input.
- This build intentionally does **not** silently request administrator privileges.

## Troubleshooting

- **QR opens page but no connection**:
  - Ensure phone and desktop are on same Wi‑Fi/LAN.
  - Verify firewall allows inbound `4850` and `3000`.
- **Pairing token expired**:
  - Click **Generate Fresh QR**.
- **Can’t move cursor**:
  - Confirm companion is running on Windows.
  - Confirm desktop approved the pairing request.
- **Wrong IP in QR**:
  - Use companion interface selection endpoint (`/api/interfaces` + `/api/interface/select`) and regenerate QR.

## First-use quick flow

1. Start companion.
2. Open desktop dashboard and click **Generate Fresh QR**.
3. Scan QR with smartphone browser.
4. Approve request on desktop.
5. Use phone trackpad/buttons to control Windows cursor.

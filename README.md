# Mobile as Cursor

Mobile as Cursor turns a smartphone browser into a wireless touchpad for a Windows PC.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/your-username/mobileascursor)

---

## What is included

- **Premium Next.js Web UI (Vercel Ready)**
  - Futuristic dark welcome page (`/`)
  - Desktop dashboard with live pairing status, dynamic QR code generation, and companion host config (`/dashboard`)
  - Settings panel with customizable sensitivity, acceleration, and touch controls (`/settings`)
  - Mobile remote touchpad with relative touch tracking, gestures, and quick reconnection tools (`/remote`)
- **Local desktop companion** (`companion/`)
  - Local HTTP API + WebSocket server
  - CORS enabled for cross-origin dashboard connections
  - QR token pairing lifecycle with approval/reject flow
  - One authorized controller at a time
  - Heartbeat timeout and forced button release on disconnect
  - Windows-native input injection (mouse, click, scroll, maximize, restore, zoom shortcuts) via PowerShell + User32

---

## Deploy to Vercel

The Next.js web application is 100% Vercel ready.

### Option 1: Deploy with Git (Recommended)
1. Push your repository to GitHub, GitLab, or Bitbucket.
2. Go to [Vercel](https://vercel.com/) and click **Add New Project**.
3. Select your repository.
4. Framework Preset will be automatically detected as **Next.js**.
5. Build and Output Settings:
   - **Build Command:** `next build` (or leave default)
   - **Output Directory:** `.next` (default)
   - **Install Command:** `npm install` (default)
6. Click **Deploy**.

### Option 2: Deploy with Vercel CLI
```bash
npm i -g vercel
vercel
```

### Environment Variables on Vercel
All environment variables are optional:
- `NEXT_PUBLIC_COMPANION_URL`: (Optional) Custom companion URL. Defaults to `http://127.0.0.1:4850`.
- `DATABASE_URL`: (Optional) PostgreSQL connection string if you connect a database. If omitted, the app runs gracefully without database requirements.

---

## How It Works with Vercel

```
  +-----------------------------------------------------------+
  |                   VERCEL GLOBAL CDN                       |
  |  Hosts the Next.js Web UI (/dashboard, /remote, /settings)|
  +-----------------------------------------------------------+
               ^                                   ^
               | 1. Opens dashboard                | 3. Scans QR to load
               |    in browser                     |    /remote on mobile
               v                                   v
  +-------------------------+             +-------------------+
  |   Desktop PC (Windows)  |             |  Mobile Phone     |
  | Runs Companion Daemon   |<~~~~~~~~~~~>| Controls Trackpad |
  | (HTTP: 4850 / WS: 4850) |  WebSocket  | over local Wi-Fi  |
  +-------------------------+             +-------------------+
```

1. **Dashboard**: You open `https://your-app.vercel.app/dashboard` on your Windows PC. The dashboard connects to your local desktop companion daemon running on `http://127.0.0.1:4850`.
2. **Pairing QR**: The dashboard generates a QR code containing your pairing token and your PC's local network IP.
3. **Remote Control**: Scan the QR code on your smartphone. The phone loads the UI from Vercel and connects directly to your desktop companion over Wi-Fi (`ws://<PC-LAN-IP>:4850/ws`).
4. **Approve & Control**: Click **Approve** on your desktop, and use your phone as a trackpad!

---

## Local Development

### 1. Install Dependencies
```bash
npm install
```

### 2. Run the Next.js UI
```bash
npm run dev
```

### 3. Run the Companion Daemon (in another terminal)
```bash
npm run companion:dev
```

By default:
- Next.js Web UI: `http://localhost:3000`
- Companion API + WS: `http://localhost:4850` and `ws://<LAN-IP>:4850/ws`

---

## Production Build & Packaging

### Build Next.js App
```bash
npm run build
```

### Build and Run Companion
```bash
npm run companion:build
npm run companion:start
```

### Package Standalone Windows Executable
```bash
npm run companion:package-win
```
Output: `dist/mobile-as-cursor-companion.exe`

---

## Security Model

- Pairing token is cryptographically random and short-lived.
- Pairing must be approved on the desktop dashboard.
- Only one mobile device can control the desktop at a time.
- Commands are schema-validated with Zod.
- Unauthorized or expired sessions are rejected.
- Heartbeat timeout auto-disconnects and safely releases mouse button state.
- Input injection operates strictly between your mobile device and Windows PC.

---

## Supported Command Set

- `mouse_move` (relative smooth tracking)
- `left_click`, `right_click`, `double_click`
- `scroll` (two-finger scroll, natural scroll toggle)
- `drag_start`, `drag_end` (drag lock support)
- `maximize_window`, `restore_window`
- `zoom_in`, `zoom_out`, `reset_zoom`
- `heartbeat`, `disconnect`

---

## Troubleshooting

- **QR opens page but connection fails**:
  - Ensure your phone and PC are connected to the same Wi-Fi / LAN network.
  - Verify Windows Defender Firewall allows inbound traffic on port `4850`.
  - On the remote screen, click **Host** to verify or manually input your PC's Wi-Fi IP.
- **Viewing Dashboard on HTTPS (Vercel) shows "Connection Failed"**:
  - In your PC browser, allow local network access / insecure content for your Vercel domain, or set a secure tunnel for companion (e.g. Cloudflare Tunnel or ngrok).
  - Alternatively, open the dashboard locally at `http://localhost:3000/dashboard`.
- **Can’t move cursor**:
  - Ensure companion is running on your Windows machine.
  - Ensure you clicked **Approve** on the desktop dashboard.

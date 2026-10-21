# Mobile as Cursor

> Turn your smartphone into a wireless mouse — control your computer with just a touch.

## Features

- 📱 **Touch Trackpad** — Use your phone screen as a cursor controller
- ⚡ **Direct Wi-Fi Mode** — Low-latency local connection (same network)
- ☁️ **Cloud Relay Mode** — Works across **any network** (mobile data, different Wi-Fi)
- 🖱️ **Full Mouse Control** — Move, left/right click, double click, drag, scroll
- 🔍 **Window Controls** — Maximize, restore, zoom in/out
- 🔐 **Token-based Pairing** — Secure QR code authentication with expiry
- 🎨 **Premium UI** — Glassmorphism design with smooth animations
- 🚀 **Vercel Ready** — Deploy the web app to Vercel, run companion locally

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Mobile     │────▶│  Vercel Cloud    │────▶│   Companion     │
│   Phone      │     │  (Relay API)     │     │   (Your PC)     │
│              │     │                  │     │                 │
│  Touch pad   │     │  /api/relay      │     │  Mouse inject   │
│  Buttons     │     │  (message broker)│     │  input-injector  │
└─────────────┘     └──────────────────┘     └─────────────────┘
       │                                            │
       │         Direct Wi-Fi (Same Network)        │
       └────────────────────────────────────────────┘
```

### Two Connection Modes

| Mode | Network Requirement | Latency | How It Works |
|------|-------------------|---------|-------------|
| **⚡ Direct Wi-Fi** | Same Wi-Fi network | ~5ms | Phone → WebSocket → Companion |
| **☁️ Cloud Relay** | Any network | ~80-150ms | Phone → HTTP POST → Vercel API → Companion polls |

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Run the Companion (on your PC)

```bash
# For direct Wi-Fi mode only:
npm run companion:dev

# For cloud relay mode (cross-network), set your Vercel URL first:
# Create a .env file with: APP_WEB_URL=https://your-app.vercel.app
npm run companion:dev
```

### 3. Run the Web Dashboard

```bash
npm run dev
```

### 4. Scan the QR Code

- Open `http://localhost:3000/dashboard` on your PC
- Choose **Direct Wi-Fi** or **Cloud** mode
- Scan the QR code with your phone
- Start controlling your cursor!

## Deploy to Vercel

### Web App (Vercel)

1. Push to GitHub
2. Import to Vercel
3. Deploy — no environment variables needed for the web app

### Companion (Your PC)

The companion must run on the PC you want to control. Create a `.env` file:

```env
# Required for cloud relay (cross-network support)
APP_WEB_URL=https://your-project.vercel.app

# Optional: custom ports
COMPANION_PORT=4850
```

Then run:

```bash
npm run companion:dev
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEXT_PUBLIC_COMPANION_URL` | No | `http://127.0.0.1:4850` | Companion server URL for dashboard |
| `APP_WEB_URL` | No | — | Your Vercel deployment URL (enables cloud relay) |
| `COMPANION_PORT` | No | `4850` | Companion server port |
| `APP_WEB_PORT` | No | `3000` | Next.js dev server port |
| `DATABASE_URL` | No | — | PostgreSQL connection (optional) |

## Tech Stack

- **Frontend**: Next.js 16, React 19, TailwindCSS 4
- **Companion**: Express, WebSocket (ws), native input injection
- **Cloud Relay**: Vercel Serverless Functions (in-memory message broker)
- **Mouse Control**: Custom C# `input-injector.exe` using Win32 SendInput API

## Project Structure

```
├── src/
│   ├── app/
│   │   ├── page.tsx           # Welcome/landing page
│   │   ├── dashboard/         # QR code generator & pairing dashboard
│   │   ├── remote/            # Mobile touch controller (trackpad)
│   │   ├── settings/          # Controller settings
│   │   └── api/
│   │       ├── health/        # Health check endpoint
│   │       └── relay/         # Cloud relay API (message broker)
│   └── lib/
│       └── control-protocol.ts # Shared protocol definitions
├── companion/
│   └── src/
│       ├── index.ts           # Companion server (Express + WebSocket)
│       ├── cloud-relay.ts     # Cloud relay polling client
│       ├── native-controller.ts # Win32 mouse injection
│       ├── session-manager.ts # Pairing session management
│       ├── protocol.ts        # Wire protocol schemas
│       └── network.ts         # Network interface discovery
└── vercel.json                # Vercel deployment config
```

## License

MIT

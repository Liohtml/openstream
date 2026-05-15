# OpenStream

Self-hosted streaming app for Smart TVs. Browse movies and TV shows with a Netflix-style UI optimized for TV remote control navigation, then stream directly on your TV.

## How It Works

```
[Smart TV Browser] <--LAN--> [Your Server (Node.js)]
                                    |
                              +-----+-----+
                              |           |
                           TMDB API   Streaming
                          (Catalog)   (Sources)
```

- **Server** runs on any machine in your network (Raspberry Pi, laptop, PC)
- **TV** opens `http://<server-ip>:3000` in its built-in browser
- **Catalog** comes from TMDB (The Movie Database)
- **Streams** are fetched from available streaming sources

## Features

- TV-optimized UI (D-Pad / remote control navigation)
- Movie and TV show catalog with categories
- Search functionality
- Multiple streaming servers with quality selection
- HLS video player with progress bar
- Season/episode browser for TV shows
- ES5-compatible (works on older Smart TV browsers like VIDAA)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USER/openstream.git
cd openstream
cp .env.example .env
# Edit .env with your TMDB API key (free at https://themoviedb.org/settings/api)
npm install
```

### 2. Start the server

```bash
npm start
```

### 3. Activate streaming tokens

Open `http://<server-ip>:3000/token` on any device (phone, PC). This page solves a Cloudflare challenge and sends the token to your server. Keep it open -- it auto-refreshes every 90 minutes.

### 4. Open on your TV

Navigate to `http://<server-ip>:3000` in your Smart TV browser.

## Remote Deployment (e.g. Raspberry Pi / headless server)

```bash
# Copy files to remote machine
scp -r server.js package.json .env public/ user@remote:~/openstream/

# SSH in and start
ssh user@remote
cd ~/openstream
npm install
tmux new-session -d -s openstream "node server.js"
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `TMDB_KEY` | TMDB API key for movie/show metadata | Yes |
| `MOONLIGHT_URL` | Backend API URL | Yes |
| `STREAMO_ORIGIN` | Origin URL for token exchange | Yes |
| `TURNSTILE_SITEKEY` | Cloudflare Turnstile site key | Yes |
| `PORT` | Server port (default: 3000) | No |

## TV Remote Controls

| Key | Action |
|-----|--------|
| Arrow keys | Navigate |
| Enter/OK | Select |
| Escape/Back | Close player / go back |

## Token Lifecycle

- **Moonlight token**: 2 hours, auto-refreshed via `/token` page
- **Kenma token**: 15 minutes, auto-refreshed by server
- **Server list**: 10 minute cache

## Tech Stack

- **Server**: Node.js + Express
- **Frontend**: Vanilla HTML/CSS/JS (ES5 compatible, no build step)
- **Player**: hls.js (loaded from CDN)
- **Data**: TMDB API

## License

MIT

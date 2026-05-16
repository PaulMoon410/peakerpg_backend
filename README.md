# Peake API (Standalone Backend)

This backend is intentionally separate from the frontend in `The Peake/`.

## Why separate
- Frontend can stay hosted at `http://geocities.ws/peakecoin/games/peake_rpg`
- Backend runs independently as a Node.js API (HTTPS in production on Render)
- Frontend calls backend through API requests

## Run
1. Open this folder in a terminal.
2. Copy environment settings:
   - `cp .env.example .env` (optional)
3. Start server:
   - `npm start`

Server defaults to:
- `http://localhost:3001`

In production (Render):
- Public URL should be HTTPS, for example `https://your-render-service.onrender.com`
- HTTPS is enforced when `NODE_ENV=production` and `ENFORCE_HTTPS=true`

FTP save layout:
- `accounts/<username>/account.json` for account credentials
- `characters/<username>/character.json` for character data
- `game_state/<username>/game_state.json` for world/session state

Required FTP env vars:
- `PEAKE_FTP_HOST`
- `PEAKE_FTP_USER`
- `PEAKE_FTP_PASS`
- `PEAKE_FTP_PORT` (optional, default `21`)
- `PEAKE_FTP_ROOT` (optional, default `/games/peake_rpg/saves`)

## Endpoints
- `GET /health`
- `GET /api/ping`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/save`
- `GET /api/save`
- `POST /api/world/join`
- `POST /api/world/update`
- `POST /api/world/chat`
- `POST /api/world/leave`
- `GET /api/world/state`
- `GET /api/world/stream?token=...`

## Live World
- This is a live shared-world foundation for MMO-style play.
- Connected players appear in the same world presence list.
- Movement updates current room/location live.
- Chat is streamed in real time with Server-Sent Events (SSE).
- Current live world state is held in backend memory, so horizontal scaling or process restarts would need a shared state layer later.

## Frontend fetch example
```js
fetch('https://YOUR_RENDER_BACKEND/api/ping')
  .then((r) => r.json())
  .then((data) => console.log(data));
```

## CORS
Set `FRONTEND_ORIGIN` to your frontend origin (scheme + host only, no path). Example for your site:
- `https://geocities.ws`

For example, if the page is:
- `https://geocities.ws/peakecoin/games/peake_rpg`

Then `FRONTEND_ORIGIN` is still:
- `https://geocities.ws`

Optional:
- `ENFORCE_HTTPS=true` keeps non-HTTPS requests blocked in production.

# Virtual Cosmos

Virtual Cosmos is a realtime 2D multiplayer world where users move in a shared arena and can interact only when they are physically close in-game.

It combines:

- Realtime avatar movement
- Proximity-based networking
- Text chat
- Voice and video calls (WebRTC)
- Moderation controls
- MongoDB-backed profile and history persistence

## Feature Coverage

This section maps directly to what the current codebase implements.

### World And Presence

- Realtime multiplayer sync with Socket.IO
- Keyboard movement with both `WASD` and arrow keys
- Client-side movement prediction with periodic server reconciliation
- Room isolation by Room ID (users only see/interact within the same room)
- Join, move, update, leave presence broadcasting
- World dimensions configurable through environment variables
- Three named zones rendered on the map:
  - `Cafe`
  - `Meeting Room`
  - `Stage`
- Zone entry/exit detection and live per-zone occupancy counters

### Proximity System

- Automatic proximity connect/disconnect based on distance
- Proximity radius is server-configurable (`PROXIMITY_RADIUS`)
- Private pair channels for nearby users
- Calls/chats end or lock automatically when users move out of range

### Communication

- Proximity-gated 1:1 text chat
- Proximity-gated voice calls
- Proximity-gated video calls
- WebRTC signaling over Socket.IO:
  - `voice:offer`
  - `voice:answer`
  - `voice:ice-candidate`
  - `voice:hangup`
- Configurable ICE servers via `ICE_SERVERS_JSON`
- Spatial audio attenuation based on distance (louder when closer)
- Local and remote video preview panels
- Quick emotes:
  - `wave`
  - `thumbs`
  - `laugh`

### Identity And Customization

- Display name
- Avatar color
- Hat options: `none`, `cap`, `halo`, `wizard`
- Badge options: `none`, `star`, `helper`, `captain`
- Persistent user identity via generated `userKey` in localStorage
- Preference persistence in localStorage:
  - display name
  - room ID
  - avatar color
  - hat
  - badge
- Last position persistence and reconnect resume

### Moderation And Safety

- Mute user
- Block/unblock user
- Report user with reason and optional details
- Blocked pairs cannot keep proximity links or exchange calls/chat
- Muted users are filtered in chat playback and audio volume

### Persistence

When MongoDB is available, the backend persists:

- `UserProfile`
  - profile fields
  - last room
  - last position
  - mute/block lists
- `ChatMessage`
  - room
  - sender/receiver keys
  - message text
  - sent timestamp
- `ModerationReport`
  - reporter
  - target
  - reason
  - details

### Reliability And Runtime Behavior

- Automatic socket reconnect
- Reconnect status updates shown in UI
- Graceful fallback to in-memory mode when Mongo is missing or invalid
- CORS allowlist with support for:
  - single frontend origin (`FRONTEND_URL`)
  - multiple origins (`FRONTEND_URLS`)
  - optional wildcard Vercel previews (`ALLOW_VERCEL_ORIGINS=true`)
- `/health` endpoint with users, rooms, Mongo, and zone metadata

## Tech Stack

### Frontend

- React 19 + Vite
- PixiJS (2D rendering)
- Socket.IO Client
- Native browser WebRTC APIs

### Backend

- Node.js + Express
- Socket.IO
- Mongoose + MongoDB Atlas

## Project Structure

```text
.
|- backend/
|  |- src/server.js
|  |- .env.example
|  |- package.json
|- frontend/
|  |- src/App.jsx
|  |- .env.example
|  |- package.json
|- package.json
```

## Local Setup

### 1. Install Dependencies

From the repository root:

```bash
npm install
npm install --prefix backend
npm install --prefix frontend
```

### 2. Create Environment Files

Windows PowerShell:

```powershell
Copy-Item backend/.env.example backend/.env
Copy-Item frontend/.env.example frontend/.env
```

macOS/Linux:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

### 3. Configure Environment Variables

#### Backend (`backend/.env`)

```env
PORT=4000
FRONTEND_URL=http://localhost:5173
FRONTEND_URLS=
ALLOW_VERCEL_ORIGINS=false
WORLD_WIDTH=1600
WORLD_HEIGHT=900
PROXIMITY_RADIUS=190
MONGO_URI=<your-mongodb-uri>
# Optional
# ICE_SERVERS_JSON=[{"urls":"stun:stun.l.google.com:19302"}]
```

#### Frontend (`frontend/.env`)

```env
VITE_SOCKET_URL=http://localhost:4000
```

### 4. Run The App

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4000`

## Scripts

### Root

- `npm run dev` -> run backend + frontend together
- `npm run dev:backend` -> run backend only
- `npm run dev:frontend` -> run frontend only
- `npm run build:frontend` -> build frontend
- `npm run start:backend` -> start backend in production mode

### Backend

- `npm run dev` -> nodemon server
- `npm run start` -> node server

### Frontend

- `npm run dev` -> Vite dev server
- `npm run build` -> production build
- `npm run preview` -> preview build

## Deployment Notes

Recommended split:

1. Frontend on Vercel (or Netlify)
2. Backend on a persistent Node host (Render, Railway, Fly.io, etc.)
3. MongoDB Atlas for persistence

Deployment checklist:

1. Set `VITE_SOCKET_URL` in frontend to backend URL.
2. Set `FRONTEND_URL` in backend to exact frontend domain.
3. Optionally add preview domains to `FRONTEND_URLS`.
4. Set `MONGO_URI` on backend.
5. Redeploy both services after environment changes.

## Health Endpoint

`GET /health` returns operational status including:

- service status
- users online
- rooms online
- Mongo configured/connected state
- runtime mode (`atlas` or `memory`)
- configured zone names

## Troubleshooting

### Mongo URI looks malformed

If your password includes special characters (`@`, `#`, `:`, etc.), URL-encode it before placing it in `MONGO_URI`.

Example: `@` becomes `%40`.

### Camera/Microphone not working

- Check browser permission prompts
- Ensure no other app is locking camera/mic
- Verify HTTPS in production for media permissions

### Can connect but cannot chat/call

- Verify both users are in the same Room ID
- Move avatars closer (communication is proximity-gated)
- Check if one user blocked the other

## Security Notes

- Do not commit real credentials to version control.
- Keep production secrets in your hosting provider environment settings.

## Demo Flow

1. Open two browser windows.
2. Join with two different names in the same Room ID.
3. Move around and verify live sync.
4. Move close enough to form a proximity connection.
5. Exchange chat messages and emotes.
6. Start voice and test spatial attenuation by moving apart.
7. Start video and verify local/remote preview.
8. Test mute, block, and report controls.
9. Switch room in one tab and verify isolation.
10. Refresh a tab and verify reconnect/resume behavior.

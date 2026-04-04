# Virtual Cosmos

A realtime 2D multiplayer world where users move around, connect by proximity, and interact through text, voice, and video.

## Implemented Features

- Realtime movement with PixiJS avatars (WASD + Arrow keys)
- Socket.IO multiplayer sync for join/move/leave
- Proximity connect/disconnect logic
- Proximity-gated text chat
- Proximity-gated voice and video chat (WebRTC signaling over Socket.IO)
- Spatial audio attenuation based on distance
- Live video call with local/remote preview (within proximity)
- Map zones and named rooms:
  - Cafe
  - Meeting Room
  - Stage
- Zone change detection and room occupancy counters
- Reconnect/resume behavior:
  - Automatic socket reconnect
  - Last position resume on reconnect and relaunch
- Emotes and quick reactions:
  - wave
  - thumbs
  - laugh
- User customization:
  - display name
  - avatar color
  - hat
  - badge
  - profile persistence in MongoDB Atlas
- Moderation basics:
  - mute user
  - block user
  - report user

## Stack

### Frontend
- React + Vite
- PixiJS
- Socket.IO client
- WebRTC (browser native)

### Backend
- Node.js + Express
- Socket.IO
- MongoDB Atlas via Mongoose

## MongoDB Atlas Persistence

Persistence is implemented in backend models:

- `UserProfile`
  - `userKey`
  - `displayName`
  - `avatarColor`
  - `hat`
  - `badge`
  - `lastX`
  - `lastY`
  - `blockedUserKeys`
  - `mutedUserKeys`
- `ChatMessage`
  - `fromUserKey`
  - `toUserKey`
  - `text`
  - `sentAt`
- `ModerationReport`
  - `reporterUserKey`
  - `targetUserKey`
  - `reason`
  - `details`

### Atlas Setup

1. Create a MongoDB Atlas cluster.
2. Create a database user.
3. Add IP access:
   - For local testing: your current IP.
   - For cloud backend: `0.0.0.0/0` (or your hosting provider's static range).
4. Copy connection string.
5. Put it in backend environment as `MONGO_URI`.

Example:

```env
MONGO_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/virtual-cosmos?retryWrites=true&w=majority
```

## Local Development

### 1. Install

From repository root:

```bash
npm install
npm install --prefix backend
npm install --prefix frontend
```

### 2. Environment files

Backend:

```bash
cp backend/.env.example backend/.env
```

Frontend:

```bash
cp frontend/.env.example frontend/.env
```

### 3. Fill env values

Backend `.env`:

```env
PORT=4000
FRONTEND_URL=http://localhost:5173
FRONTEND_URLS=
WORLD_WIDTH=1600
WORLD_HEIGHT=900
PROXIMITY_RADIUS=190
MONGO_URI=<your atlas uri>
# Optional custom ICE servers JSON
# ICE_SERVERS_JSON=[{"urls":"stun:stun.l.google.com:19302"}]
```

Frontend `.env`:

```env
VITE_SOCKET_URL=http://localhost:4000
```

### 4. Run

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4000`

## Deployment Guide (Frontend + Backend)

Vercel is ideal for frontend. Socket backend should run on a persistent Node host.

### Recommended Architecture

1. Frontend: Vercel
2. Backend: Render or Railway
3. Database: MongoDB Atlas

### Backend Deployment (Render)

1. Create Web Service from your GitHub repo.
2. Root directory: `backend`
3. Build command: `npm install`
4. Start command: `npm run start`
5. Add env vars:
   - `PORT=4000`
   - `FRONTEND_URL=https://<your-vercel-domain>`
   - `FRONTEND_URLS=https://<preview-domain-1>,https://<preview-domain-2>` (optional)
   - `WORLD_WIDTH=1600`
   - `WORLD_HEIGHT=900`
   - `PROXIMITY_RADIUS=190`
   - `MONGO_URI=<atlas uri>`
   - `ICE_SERVERS_JSON=<optional JSON>`
6. Deploy and copy backend URL (example: `https://virtual-cosmos-api.onrender.com`).

### Frontend Deployment (Vercel)

1. Import repo into Vercel.
2. Project root: `frontend`
3. Framework preset: Vite
4. Environment variables:
   - `VITE_SOCKET_URL=https://<your-backend-domain>`
5. Deploy.

### Final CORS Step

Update backend `FRONTEND_URL` with your exact Vercel production URL and redeploy backend.

## WebRTC Notes

- Signaling is handled through Socket.IO events for both voice and video:
  - `voice:offer`
  - `voice:answer`
  - `voice:ice-candidate`
  - `voice:hangup`
- Default STUN server works for many networks.
- For stricter NAT/firewall environments, provide TURN in `ICE_SERVERS_JSON`.

Example with TURN:

```env
ICE_SERVERS_JSON=[
  {"urls":"stun:stun.l.google.com:19302"},
  {"urls":"turn:turn.example.com:3478","username":"user","credential":"pass"}
]
```

## Scripts

Root:

- `npm run dev` : start backend + frontend
- `npm run dev:backend`
- `npm run dev:frontend`
- `npm run build:frontend`
- `npm run start:backend`

Backend:

- `npm run dev`
- `npm run start`

Frontend:

- `npm run dev`
- `npm run build`
- `npm run preview`

## Demo Checklist

1. Open two windows.
2. Join with different profiles.
3. Show movement sync.
4. Move into same zone and show zone indicator.
5. Show proximity chat enabling/disabling.
6. Start voice and demonstrate spatial audio by moving.
7. Start video call and show local/remote previews.
8. Send emotes.
9. Apply mute/block/report actions.
10. Refresh one tab and show reconnect/resume.

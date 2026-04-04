# Virtual Cosmos - Proximity Multiplayer Assignment

A 2D realtime virtual environment where users move in a shared space and chat only when they are physically close in the world.

## What This Implements

- 2D arena with PixiJS rendering
- Keyboard movement (WASD + Arrow keys)
- Realtime multiplayer presence with Socket.IO
- Proximity detection on the backend
- Auto connect/disconnect logic based on distance radius
- Chat enabled only while users remain within proximity
- Active connections UI and room-scoped messaging
- Optional MongoDB session persistence (last known user position)

## Stack And Justification

### Frontend
- React + Vite: fast iteration and simple state/event wiring for realtime updates.
- PixiJS: high-performance 2D rendering and smooth avatar updates.
- Tailwind CSS: quick, consistent UI composition with custom visual theming.

### Backend
- Node.js + Express: lightweight API/runtime foundation.
- Socket.IO: robust bidirectional events for movement and chat.
- MongoDB (optional): stores user last position/session state if `MONGO_URI` is set.

## Project Structure

- `frontend/`: React app, Pixi canvas world, movement + chat UI
- `backend/`: Express + Socket.IO server, world state + proximity logic

## Local Setup

### 1. Install dependencies

From repository root:

```bash
npm install
npm install --prefix frontend
npm install --prefix backend
```

### 2. Configure environment

Backend:

```bash
cp backend/.env.example backend/.env
```

Frontend:

```bash
cp frontend/.env.example frontend/.env
```

If you want Mongo persistence, set `MONGO_URI` in `backend/.env`.

### 3. Run both apps

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4000`

## Assignment Requirements Mapping

1. User movement
- Implemented in frontend movement loop using keyboard input and speed normalization.
- Users rendered as circles/avatars in PixiJS.

2. Realtime multiplayer
- Backend tracks active users in memory and broadcasts join/move/leave events.
- Frontend receives socket events and updates canvas in realtime.

3. Proximity detection
- Backend computes Euclidean distance between moving user and every other user.
- Threshold is `PROXIMITY_RADIUS`.

4. Chat system
- If users are within radius, backend creates a pair room and sends proximity snapshot.
- If users move apart, backend removes room membership and updates snapshot.
- Chat input is enabled only when an active proximity connection exists.

5. UI/UX
- Custom visual direction, responsive layout for desktop/mobile.
- Displays avatars, online status, nearby connections, and chat panel.

## Backend Event Contract (Socket.IO)

- `world:init`
- `world:user-joined`
- `world:user-moved`
- `world:user-left`
- `proximity:snapshot`
- `chat:send`
- `chat:message`

## Quick Demo Script (2-5 min)

1. Open two browser windows/tabs.
2. Enter different display names.
3. Show independent movement.
4. Move avatars together until nearby list populates.
5. Send chat message while connected.
6. Move one avatar away and show chat disabling/disconnect behavior.
7. (Optional) Show persistence with Mongo enabled.

## Notes

- MongoDB is optional and only used for session persistence.
- Core multiplayer/proximity/chat behavior works fully in memory without Mongo.

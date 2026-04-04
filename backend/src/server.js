const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

dotenv.config();

const PORT = Number(process.env.PORT || 4000);
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const WORLD_WIDTH = Number(process.env.WORLD_WIDTH || 1600);
const WORLD_HEIGHT = Number(process.env.WORLD_HEIGHT || 900);
const PROXIMITY_RADIUS = Number(process.env.PROXIMITY_RADIUS || 190);

const SessionState = mongoose.model(
	"SessionState",
	new mongoose.Schema(
		{
			userKey: { type: String, required: true, unique: true, index: true },
			displayName: { type: String, required: true },
			x: { type: Number, required: true },
			y: { type: Number, required: true },
		},
		{
			timestamps: true,
		},
	),
);

const app = express();
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
	cors: {
		origin: FRONTEND_URL,
		methods: ["GET", "POST"],
	},
});

const users = new Map();

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const createRandomSpawn = () => ({
	x: Math.round(100 + Math.random() * (WORLD_WIDTH - 200)),
	y: Math.round(100 + Math.random() * (WORLD_HEIGHT - 200)),
});

const distance = (a, b) => {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return Math.sqrt(dx * dx + dy * dy);
};

const pairRoomId = (socketIdA, socketIdB) => {
	const [first, second] = [socketIdA, socketIdB].sort();
	return `proximity:${first}:${second}`;
};

const toClientUser = (user) => ({
	id: user.socketId,
	userId: user.userKey,
	name: user.displayName,
	x: user.x,
	y: user.y,
	connections: Array.from(user.connections),
});

const emitConnectionSnapshot = (socketId) => {
	const user = users.get(socketId);
	if (!user) {
		return;
	}

	const connectedUsers = Array.from(user.connections)
		.map((connectedSocketId) => users.get(connectedSocketId))
		.filter(Boolean)
		.map(toClientUser);

	io.to(socketId).emit("proximity:snapshot", {
		connectedUserIds: connectedUsers.map((connectedUser) => connectedUser.id),
		connectedUsers,
	});
};

const connectUsers = (socketIdA, socketIdB) => {
	const userA = users.get(socketIdA);
	const userB = users.get(socketIdB);

	if (!userA || !userB || userA.connections.has(socketIdB)) {
		return;
	}

	userA.connections.add(socketIdB);
	userB.connections.add(socketIdA);

	const roomId = pairRoomId(socketIdA, socketIdB);
	io.sockets.sockets.get(socketIdA)?.join(roomId);
	io.sockets.sockets.get(socketIdB)?.join(roomId);

	emitConnectionSnapshot(socketIdA);
	emitConnectionSnapshot(socketIdB);
};

const disconnectUsers = (socketIdA, socketIdB) => {
	const userA = users.get(socketIdA);
	const userB = users.get(socketIdB);

	if (!userA || !userB || !userA.connections.has(socketIdB)) {
		return;
	}

	userA.connections.delete(socketIdB);
	userB.connections.delete(socketIdA);

	const roomId = pairRoomId(socketIdA, socketIdB);
	io.sockets.sockets.get(socketIdA)?.leave(roomId);
	io.sockets.sockets.get(socketIdB)?.leave(roomId);

	emitConnectionSnapshot(socketIdA);
	emitConnectionSnapshot(socketIdB);
};

const reconcileProximity = (sourceSocketId) => {
	const sourceUser = users.get(sourceSocketId);
	if (!sourceUser) {
		return;
	}

	for (const [targetSocketId, targetUser] of users.entries()) {
		if (targetSocketId === sourceSocketId) {
			continue;
		}

		const isWithinRange = distance(sourceUser, targetUser) < PROXIMITY_RADIUS;
		const isConnected = sourceUser.connections.has(targetSocketId);

		if (isWithinRange && !isConnected) {
			connectUsers(sourceSocketId, targetSocketId);
		}

		if (!isWithinRange && isConnected) {
			disconnectUsers(sourceSocketId, targetSocketId);
		}
	}
};

const persistUser = async (user) => {
	if (!process.env.MONGO_URI) {
		return;
	}

	try {
		await SessionState.findOneAndUpdate(
			{ userKey: user.userKey },
			{
				userKey: user.userKey,
				displayName: user.displayName,
				x: user.x,
				y: user.y,
			},
			{ upsert: true, new: true },
		);
	} catch (error) {
		console.error("Failed to persist user state", error.message);
	}
};

io.on("connection", async (socket) => {
	const displayName = String(socket.handshake.auth?.name || "Cosmonaut").slice(0, 24);
	const userKey = String(socket.handshake.auth?.userKey || socket.id).slice(0, 64);

	let spawn = createRandomSpawn();
	if (process.env.MONGO_URI) {
		try {
			const existing = await SessionState.findOne({ userKey }).lean();
			if (existing) {
				spawn = {
					x: clamp(existing.x, 0, WORLD_WIDTH),
					y: clamp(existing.y, 0, WORLD_HEIGHT),
				};
			}
		} catch (error) {
			console.error("Failed to read previous user position", error.message);
		}
	}

	const user = {
		socketId: socket.id,
		userKey,
		displayName,
		x: spawn.x,
		y: spawn.y,
		connections: new Set(),
	};

	users.set(socket.id, user);

	socket.emit("world:init", {
		selfId: socket.id,
		config: {
			worldWidth: WORLD_WIDTH,
			worldHeight: WORLD_HEIGHT,
			proximityRadius: PROXIMITY_RADIUS,
		},
		users: Array.from(users.values()).map(toClientUser),
	});

	socket.broadcast.emit("world:user-joined", toClientUser(user));
	reconcileProximity(socket.id);

	socket.on("player:move", (payload) => {
		const activeUser = users.get(socket.id);
		if (!activeUser) {
			return;
		}

		if (typeof payload?.x !== "number" || typeof payload?.y !== "number") {
			return;
		}

		activeUser.x = clamp(Math.round(payload.x), 0, WORLD_WIDTH);
		activeUser.y = clamp(Math.round(payload.y), 0, WORLD_HEIGHT);

		reconcileProximity(socket.id);
		io.emit("world:user-moved", toClientUser(activeUser));
	});

	socket.on("chat:send", (payload) => {
		const sourceUser = users.get(socket.id);
		if (!sourceUser) {
			return;
		}

		const toUserId = String(payload?.toUserId || "");
		const text = String(payload?.text || "").trim();

		if (!toUserId || !sourceUser.connections.has(toUserId) || !text) {
			return;
		}

		const roomId = pairRoomId(socket.id, toUserId);
		io.to(roomId).emit("chat:message", {
			roomId,
			fromId: socket.id,
			toId: toUserId,
			text: text.slice(0, 300),
			sentAt: new Date().toISOString(),
		});
	});

	socket.on("disconnect", async () => {
		const departingUser = users.get(socket.id);
		if (!departingUser) {
			return;
		}

		for (const connectedSocketId of Array.from(departingUser.connections)) {
			disconnectUsers(socket.id, connectedSocketId);
		}

		users.delete(socket.id);
		io.emit("world:user-left", { id: socket.id });
		await persistUser(departingUser);
	});
});

app.get("/health", (_, res) => {
	res.json({
		status: "ok",
		usersOnline: users.size,
	});
});

const start = async () => {
	if (process.env.MONGO_URI) {
		try {
			await mongoose.connect(process.env.MONGO_URI);
			console.log("Connected to MongoDB");
		} catch (error) {
			console.error("Mongo connection failed; continuing in memory-only mode", error.message);
		}
	}

	server.listen(PORT, () => {
		console.log(`Cosmos backend listening on port ${PORT}`);
	});
};

start();

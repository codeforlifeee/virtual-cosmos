const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const dotenv = require("dotenv");
const mongoose = require("mongoose");

dotenv.config();

const PORT = Number(process.env.PORT || 4000);
const WORLD_WIDTH = Number(process.env.WORLD_WIDTH || 1600);
const WORLD_HEIGHT = Number(process.env.WORLD_HEIGHT || 900);
const PROXIMITY_RADIUS = Number(process.env.PROXIMITY_RADIUS || 190);
const ICE_SERVERS = (() => {
	const fallback = [{ urls: "stun:stun.l.google.com:19302" }];
	const raw = process.env.ICE_SERVERS_JSON;

	if (!raw) {
		return fallback;
	}

	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.length > 0) {
			return parsed;
		}
	} catch (error) {
		console.error("Invalid ICE_SERVERS_JSON; using fallback STUN server", error.message);
	}

	return fallback;
})();
const ALLOWED_HATS = ["none", "cap", "halo", "wizard"];
const ALLOWED_BADGES = ["none", "star", "helper", "captain"];
const EMOTES = new Set(["wave", "thumbs", "laugh"]);
const DEFAULT_ROOM_ID = "lobby";

const DEFAULT_ZONES = [
	{
		id: "cafe",
		name: "Cafe",
		x: 80,
		y: 80,
		width: 320,
		height: 220,
		color: "#c9a66b",
	},
	{
		id: "meeting",
		name: "Meeting Room",
		x: 610,
		y: 230,
		width: 420,
		height: 250,
		color: "#779ecb",
	},
	{
		id: "stage",
		name: "Stage",
		x: 1180,
		y: 120,
		width: 300,
		height: 220,
		color: "#cc8ab3",
	},
];

const normalizeOrigin = (value) => String(value || "").trim().replace(/\/$/, "").toLowerCase();

const parseAllowedOrigins = () => {
	const singular = process.env.FRONTEND_URL || "http://localhost:5173";
	const plural = process.env.FRONTEND_URLS || "";

	return new Set(
		[singular, ...plural.split(",")]
			.map((value) => normalizeOrigin(value))
			.filter(Boolean),
	);
};

const allowedOrigins = parseAllowedOrigins();
const allowAnyVercelOrigin = String(process.env.ALLOW_VERCEL_ORIGINS || "false").toLowerCase() === "true";

const isOriginAllowed = (origin) => {
	if (!origin) {
		return true;
	}

	const normalized = normalizeOrigin(origin);
	if (allowedOrigins.has(normalized)) {
		return true;
	}

	if (allowAnyVercelOrigin && normalized.endsWith(".vercel.app")) {
		return true;
	}

	return false;
};

const UserProfile = mongoose.model(
	"UserProfile",
	new mongoose.Schema(
		{
			userKey: { type: String, required: true, unique: true, index: true },
			displayName: { type: String, required: true },
			avatarColor: { type: String, required: true },
			hat: { type: String, required: true },
			badge: { type: String, required: true },
			lastRoomId: { type: String, default: DEFAULT_ROOM_ID },
			lastX: { type: Number, required: true },
			lastY: { type: Number, required: true },
			blockedUserKeys: { type: [String], default: [] },
			mutedUserKeys: { type: [String], default: [] },
		},
		{
			timestamps: true,
		},
	),
);

const ModerationReport = mongoose.model(
	"ModerationReport",
	new mongoose.Schema(
		{
			roomId: { type: String, required: true, index: true },
			reporterUserKey: { type: String, required: true, index: true },
			targetUserKey: { type: String, required: true, index: true },
			reason: { type: String, required: true },
			details: { type: String, default: "" },
		},
		{
			timestamps: true,
		},
	),
);

const ChatMessage = mongoose.model(
	"ChatMessage",
	new mongoose.Schema(
		{
			roomId: { type: String, required: true, index: true },
			fromUserKey: { type: String, required: true, index: true },
			toUserKey: { type: String, required: true, index: true },
			text: { type: String, required: true },
			sentAt: { type: Date, required: true },
		},
		{
			timestamps: true,
		},
	),
);

const app = express();
app.use(
	cors({
		origin(origin, callback) {
			if (isOriginAllowed(origin)) {
				callback(null, true);
				return;
			}

			callback(new Error("Origin not allowed by CORS"));
		},
		credentials: true,
	}),
);
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
	cors: {
		origin(origin, callback) {
			if (isOriginAllowed(origin)) {
				callback(null, true);
				return;
			}

			callback(new Error("Origin not allowed by CORS"));
		},
		methods: ["GET", "POST"],
	},
});

const users = new Map();

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const safeName = (value) => String(value || "Cosmonaut").trim().slice(0, 24) || "Cosmonaut";

const safeHexColor = (value) => {
	const normalized = String(value || "").trim();
	return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized : "#34d399";
};

const safeRoomId = (value) => {
	const normalized = String(value || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-_]/g, "")
		.slice(0, 32);

	return normalized || DEFAULT_ROOM_ID;
};

const worldRoomId = (roomId) => `world:${roomId}`;

const safeHat = (value) => (ALLOWED_HATS.includes(value) ? value : "none");
const safeBadge = (value) => (ALLOWED_BADGES.includes(value) ? value : "none");

const createRandomSpawn = () => ({
	x: Math.round(100 + Math.random() * (WORLD_WIDTH - 200)),
	y: Math.round(100 + Math.random() * (WORLD_HEIGHT - 200)),
});

const distance = (a, b) => {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return Math.sqrt(dx * dx + dy * dy);
};

const findZoneId = (x, y) => {
	for (const zone of DEFAULT_ZONES) {
		const insideX = x >= zone.x && x <= zone.x + zone.width;
		const insideY = y >= zone.y && y <= zone.y + zone.height;

		if (insideX && insideY) {
			return zone.id;
		}
	}

	return null;
};

const pairRoomId = (roomId, socketIdA, socketIdB) => {
	const [first, second] = [socketIdA, socketIdB].sort();
	return `proximity:${roomId}:${first}:${second}`;
};

const isPairBlocked = (userA, userB) =>
	userA.blockedUserKeys.has(userB.userKey) || userB.blockedUserKeys.has(userA.userKey);

const toClientUser = (user) => ({
	id: user.socketId,
	userId: user.userKey,
	name: user.displayName,
	x: user.x,
	y: user.y,
	zoneId: user.zoneId,
	roomId: user.roomId,
	avatarColor: user.avatarColor,
	hat: user.hat,
	badge: user.badge,
	connections: Array.from(user.connections),
});

const emitModerationState = (socketId) => {
	const user = users.get(socketId);
	if (!user) {
		return;
	}

	io.to(socketId).emit("moderation:state", {
		blockedUserKeys: Array.from(user.blockedUserKeys),
		mutedUserKeys: Array.from(user.mutedUserKeys),
	});
};

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

	if (!userA || !userB || userA.connections.has(socketIdB) || isPairBlocked(userA, userB)) {
		return;
	}

	if (userA.roomId !== userB.roomId) {
		return;
	}

	userA.connections.add(socketIdB);
	userB.connections.add(socketIdA);

	const roomId = pairRoomId(userA.roomId, socketIdA, socketIdB);
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

	const roomId = pairRoomId(userA.roomId, socketIdA, socketIdB);
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

		if (sourceUser.roomId !== targetUser.roomId) {
			if (sourceUser.connections.has(targetSocketId)) {
				disconnectUsers(sourceSocketId, targetSocketId);
			}
			continue;
		}

		const blocked = isPairBlocked(sourceUser, targetUser);
		const isWithinRange = distance(sourceUser, targetUser) < PROXIMITY_RADIUS;
		const isConnected = sourceUser.connections.has(targetSocketId);

		if ((blocked || !isWithinRange) && isConnected) {
			disconnectUsers(sourceSocketId, targetSocketId);
			continue;
		}

		if (!blocked && isWithinRange && !isConnected) {
			connectUsers(sourceSocketId, targetSocketId);
		}
	}
};

const persistProfile = async (user) => {
	if (!process.env.MONGO_URI) {
		return;
	}

	try {
		await UserProfile.findOneAndUpdate(
			{ userKey: user.userKey },
			{
				userKey: user.userKey,
				displayName: user.displayName,
				avatarColor: user.avatarColor,
				hat: user.hat,
				badge: user.badge,
				lastRoomId: user.roomId,
				lastX: user.x,
				lastY: user.y,
				blockedUserKeys: Array.from(user.blockedUserKeys),
				mutedUserKeys: Array.from(user.mutedUserKeys),
			},
			{ upsert: true, new: true },
		);
	} catch (error) {
		console.error("Failed to persist profile", error.message);
	}
};

const forwardVoiceSignal = ({
	sourceSocketId,
	toUserId,
	eventName,
	payload,
}) => {
	const sourceUser = users.get(sourceSocketId);
	const targetUser = users.get(String(toUserId || ""));

	if (!sourceUser || !targetUser || !sourceUser.connections.has(targetUser.socketId)) {
		return;
	}

	if (sourceUser.roomId !== targetUser.roomId) {
		return;
	}

	if (isPairBlocked(sourceUser, targetUser)) {
		return;
	}

	io.to(targetUser.socketId).emit(eventName, {
		fromId: sourceSocketId,
		...payload,
	});
};

io.on("connection", async (socket) => {
	const auth = socket.handshake.auth || {};
	const userKey = String(auth.userKey || socket.id).slice(0, 64);
	const roomId = safeRoomId(auth.roomId);

	let existingProfile = null;
	if (process.env.MONGO_URI) {
		try {
			existingProfile = await UserProfile.findOne({ userKey }).lean();
		} catch (error) {
			console.error("Failed to read existing profile", error.message);
		}
	}

	let spawn = createRandomSpawn();
	if (existingProfile?.lastRoomId === roomId) {
		spawn = {
			x: clamp(existingProfile.lastX, 0, WORLD_WIDTH),
			y: clamp(existingProfile.lastY, 0, WORLD_HEIGHT),
		};
	} else if (typeof auth.lastX === "number" && typeof auth.lastY === "number") {
		spawn = {
			x: clamp(auth.lastX, 0, WORLD_WIDTH),
			y: clamp(auth.lastY, 0, WORLD_HEIGHT),
		};
	}

	const user = {
		socketId: socket.id,
		userKey,
		displayName: safeName(auth.name || existingProfile?.displayName),
		avatarColor: safeHexColor(auth.avatarColor || existingProfile?.avatarColor),
		hat: safeHat(auth.hat || existingProfile?.hat),
		badge: safeBadge(auth.badge || existingProfile?.badge),
		x: spawn.x,
		y: spawn.y,
		zoneId: findZoneId(spawn.x, spawn.y),
		roomId,
		connections: new Set(),
		blockedUserKeys: new Set(existingProfile?.blockedUserKeys || []),
		mutedUserKeys: new Set(existingProfile?.mutedUserKeys || []),
		lastPersistAt: Date.now(),
	};

	users.set(socket.id, user);
	socket.join(worldRoomId(roomId));

	socket.emit("world:init", {
		selfId: socket.id,
		config: {
			worldWidth: WORLD_WIDTH,
			worldHeight: WORLD_HEIGHT,
			proximityRadius: PROXIMITY_RADIUS,
			roomId,
			zones: DEFAULT_ZONES,
			iceServers: ICE_SERVERS,
		},
		users: Array.from(users.values())
			.filter((activeUser) => activeUser.roomId === roomId)
			.map(toClientUser),
	});

	emitModerationState(socket.id);
	socket.to(worldRoomId(roomId)).emit("world:user-joined", toClientUser(user));
	reconcileProximity(socket.id);
	await persistProfile(user);

	socket.on("player:move", async (payload) => {
		const activeUser = users.get(socket.id);
		if (!activeUser) {
			return;
		}

		if (typeof payload?.x !== "number" || typeof payload?.y !== "number") {
			return;
		}

		activeUser.x = clamp(payload.x, 0, WORLD_WIDTH);
		activeUser.y = clamp(payload.y, 0, WORLD_HEIGHT);

		const previousZone = activeUser.zoneId;
		activeUser.zoneId = findZoneId(activeUser.x, activeUser.y);
		if (previousZone !== activeUser.zoneId) {
			socket.emit("zone:changed", { zoneId: activeUser.zoneId });
		}

		reconcileProximity(socket.id);
		io.to(worldRoomId(activeUser.roomId)).emit("world:user-moved", toClientUser(activeUser));

		if (Date.now() - activeUser.lastPersistAt > 5000) {
			activeUser.lastPersistAt = Date.now();
			await persistProfile(activeUser);
		}
	});

	socket.on("user:profile:update", async (payload) => {
		const activeUser = users.get(socket.id);
		if (!activeUser) {
			return;
		}

		activeUser.displayName = safeName(payload?.name || activeUser.displayName);
		activeUser.avatarColor = safeHexColor(payload?.avatarColor || activeUser.avatarColor);
		activeUser.hat = safeHat(payload?.hat || activeUser.hat);
		activeUser.badge = safeBadge(payload?.badge || activeUser.badge);

		io.to(worldRoomId(activeUser.roomId)).emit("world:user-updated", toClientUser(activeUser));
		await persistProfile(activeUser);
	});

	socket.on("chat:send", async (payload) => {
		const sourceUser = users.get(socket.id);
		const targetUser = users.get(String(payload?.toUserId || ""));
		if (!sourceUser || !targetUser) {
			return;
		}

		if (sourceUser.roomId !== targetUser.roomId) {
			return;
		}

		const text = String(payload?.text || "").trim();
		if (!text || !sourceUser.connections.has(targetUser.socketId) || isPairBlocked(sourceUser, targetUser)) {
			return;
		}

		const roomId = pairRoomId(sourceUser.roomId, socket.id, targetUser.socketId);
		io.to(roomId).emit("chat:message", {
			roomId,
			fromId: socket.id,
			toId: targetUser.socketId,
			text: text.slice(0, 300),
			sentAt: new Date().toISOString(),
		});

		if (process.env.MONGO_URI) {
			try {
				await ChatMessage.create({
					roomId: sourceUser.roomId,
					fromUserKey: sourceUser.userKey,
					toUserKey: targetUser.userKey,
					text: text.slice(0, 300),
					sentAt: new Date(),
				});
			} catch (error) {
				console.error("Failed to persist chat message", error.message);
			}
		}
	});

	socket.on("emote:send", (payload) => {
		const sourceUser = users.get(socket.id);
		const targetUser = users.get(String(payload?.toUserId || ""));
		const emote = String(payload?.emote || "");

		if (!sourceUser || !targetUser || !EMOTES.has(emote)) {
			return;
		}

		if (sourceUser.roomId !== targetUser.roomId) {
			return;
		}

		if (!sourceUser.connections.has(targetUser.socketId) || isPairBlocked(sourceUser, targetUser)) {
			return;
		}

		const roomId = pairRoomId(sourceUser.roomId, sourceUser.socketId, targetUser.socketId);
		io.to(roomId).emit("emote:show", {
			fromId: sourceUser.socketId,
			toId: targetUser.socketId,
			emote,
			sentAt: new Date().toISOString(),
		});
	});

	socket.on("voice:offer", (payload) => {
		forwardVoiceSignal({
			sourceSocketId: socket.id,
			toUserId: payload?.toUserId,
			eventName: "voice:offer",
			payload: { sdp: payload?.sdp },
		});
	});

	socket.on("voice:answer", (payload) => {
		forwardVoiceSignal({
			sourceSocketId: socket.id,
			toUserId: payload?.toUserId,
			eventName: "voice:answer",
			payload: { sdp: payload?.sdp },
		});
	});

	socket.on("voice:ice-candidate", (payload) => {
		forwardVoiceSignal({
			sourceSocketId: socket.id,
			toUserId: payload?.toUserId,
			eventName: "voice:ice-candidate",
			payload: { candidate: payload?.candidate },
		});
	});

	socket.on("voice:hangup", (payload) => {
		forwardVoiceSignal({
			sourceSocketId: socket.id,
			toUserId: payload?.toUserId,
			eventName: "voice:hangup",
			payload: {},
		});
	});

	socket.on("moderation:block", async (payload) => {
		const sourceUser = users.get(socket.id);
		const targetUser = users.get(String(payload?.targetUserId || ""));
		if (!sourceUser || !targetUser) {
			return;
		}

		if (sourceUser.roomId !== targetUser.roomId) {
			return;
		}

		const shouldBlock = Boolean(payload?.blocked);
		if (shouldBlock) {
			sourceUser.blockedUserKeys.add(targetUser.userKey);
		} else {
			sourceUser.blockedUserKeys.delete(targetUser.userKey);
		}

		if (sourceUser.connections.has(targetUser.socketId)) {
			disconnectUsers(sourceUser.socketId, targetUser.socketId);
		}

		reconcileProximity(sourceUser.socketId);
		emitModerationState(sourceUser.socketId);
		await persistProfile(sourceUser);
	});

	socket.on("moderation:mute", async (payload) => {
		const sourceUser = users.get(socket.id);
		const targetUser = users.get(String(payload?.targetUserId || ""));
		if (!sourceUser || !targetUser) {
			return;
		}

		if (sourceUser.roomId !== targetUser.roomId) {
			return;
		}

		const shouldMute = Boolean(payload?.muted);
		if (shouldMute) {
			sourceUser.mutedUserKeys.add(targetUser.userKey);
		} else {
			sourceUser.mutedUserKeys.delete(targetUser.userKey);
		}

		emitModerationState(sourceUser.socketId);
		await persistProfile(sourceUser);
	});

	socket.on("moderation:report", async (payload) => {
		const sourceUser = users.get(socket.id);
		const targetUser = users.get(String(payload?.targetUserId || ""));
		if (!sourceUser || !targetUser) {
			return;
		}

		if (sourceUser.roomId !== targetUser.roomId) {
			return;
		}

		const reason = String(payload?.reason || "other").slice(0, 40);
		const details = String(payload?.details || "").slice(0, 500);

		if (process.env.MONGO_URI) {
			try {
				await ModerationReport.create({
					roomId: sourceUser.roomId,
					reporterUserKey: sourceUser.userKey,
					targetUserKey: targetUser.userKey,
					reason,
					details,
				});
			} catch (error) {
				console.error("Failed to save moderation report", error.message);
			}
		}

		socket.emit("moderation:report:ack", {
			targetUserId: targetUser.socketId,
			reason,
			receivedAt: new Date().toISOString(),
		});
	});

	socket.on("disconnect", async () => {
		const departingUser = users.get(socket.id);
		if (!departingUser) {
			return;
		}

		const departingRoomId = departingUser.roomId;

		for (const connectedSocketId of Array.from(departingUser.connections)) {
			disconnectUsers(socket.id, connectedSocketId);
		}

		users.delete(socket.id);
		io.to(worldRoomId(departingRoomId)).emit("world:user-left", { id: socket.id });
		await persistProfile(departingUser);
	});
});

app.get("/health", (_, res) => {
	res.json({
		status: "ok",
		usersOnline: users.size,
		roomsOnline: new Set(Array.from(users.values()).map((user) => user.roomId)).size,
		mongoConfigured: Boolean(process.env.MONGO_URI),
		zones: DEFAULT_ZONES.map((zone) => ({ id: zone.id, name: zone.name })),
	});
});

const start = async () => {
	console.log("Allowed frontend origins:", Array.from(allowedOrigins.values()));
	if (allowAnyVercelOrigin) {
		console.log("Allowing all .vercel.app origins");
	}

	if (process.env.MONGO_URI) {
		try {
			await mongoose.connect(process.env.MONGO_URI);
			console.log("Connected to MongoDB Atlas");
		} catch (error) {
			console.error("Mongo connection failed; continuing in memory mode", error.message);
		}
	}

	server.listen(PORT, () => {
		console.log(`Cosmos backend listening on port ${PORT}`);
	});
};

start();

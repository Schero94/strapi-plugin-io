'use strict';

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
const MAX_TOKEN_LENGTH = 4096;
const MAX_ROOM_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 2000;

function buildCorsOptions(settings = {}) {
	const origins = Array.isArray(settings.cors?.origins)
		? [...new Set(settings.cors.origins.filter((origin) => {
			if (typeof origin !== 'string' || origin.length > 2048 || origin === '*') return false;
			try {
				const parsed = new URL(origin);
				return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin;
			} catch {
				return false;
			}
		}))]
		: ['http://localhost:3000'];
	const methods = Array.isArray(settings.cors?.methods)
		? [...new Set(settings.cors.methods.filter((method) => typeof method === 'string').map((method) => method.toUpperCase()).filter((method) => ALLOWED_METHODS.has(method)))]
		: ['GET', 'POST'];

	return {
		origin: origins,
		methods: methods.length ? methods : ['GET'],
		credentials: settings.cors?.credentials !== false,
	};
}

function createHandshakeMiddleware({ settings = {}, io, strapi }) {
	return async (socket, next) => {
		const address = socket.handshake.address;
		const security = settings.security || {};
		if (security.ipWhitelist?.length && !security.ipWhitelist.includes(address)) return next(new Error('Connection denied'));
		if (security.ipBlacklist?.includes(address)) return next(new Error('Connection denied'));
		const maxConnections = settings.connection?.maxConnections;
		if (Number.isInteger(maxConnections) && maxConnections >= 0 && io.sockets.sockets.size >= maxConnections) {
			return next(new Error('Connection limit reached'));
		}

		const token = socket.handshake.auth?.token;
		if (token && (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH)) return next(new Error('Authentication failed'));
		if (token) {
			try {
				const jwtService = strapi.plugin('users-permissions')?.service('jwt');
				if (!jwtService?.verify) throw new Error('JWT service unavailable');
				const decoded = await jwtService.verify(token);
				if (!decoded?.id) throw new Error('Invalid identity');
				const users = await strapi.documents('plugin::users-permissions.user').findMany({
					filters: { id: decoded.id }, populate: { role: true }, limit: 1,
				});
				const user = users[0];
				if (!user) throw new Error('Unknown identity');
				socket.user = { id: user.id, role: user.role?.name || 'authenticated' };
			} catch {
				return next(new Error('Authentication failed'));
			}
		} else if (security.requireAuthentication) {
			return next(new Error('Authentication required'));
		}

		const userRole = String(socket.user?.role || 'public').toLowerCase();
		const permissions = settings.rolePermissions || {};
		const rolePermissions = permissions[userRole] || (socket.user ? permissions.authenticated : permissions.public);
		if (rolePermissions?.canConnect === false) return next(new Error('Connection not allowed for this role'));
		socket.userRole = userRole;
		socket.rolePermissions = rolePermissions;
		for (const room of allowedRoomsFor(socket, settings)) {
			if (typeof room === 'string' && room.length <= MAX_ROOM_LENGTH && /^[a-zA-Z0-9_-]+$/.test(room)) await socket.join(room);
		}
		next();
	};
}

function allowedRoomsFor(socket, settings) {
	const role = socket.userRole || String(socket.user?.role || 'public').toLowerCase();
	const rooms = settings.rooms?.autoJoinByRole?.[role];
	return Array.isArray(rooms) ? rooms : [];
}

function registerRoomAccessHandlers(socket, { settings = {}, io }) {
	const respond = (callback, result) => {
		if (typeof callback === 'function') callback(result);
	};
	const isValidRoom = (room) => typeof room === 'string'
		&& room.length > 0 && room.length <= MAX_ROOM_LENGTH
		&& /^[a-zA-Z0-9_-]+$/.test(room);

	socket.on('join-room', (room, callback) => {
		if (!isValidRoom(room)) return respond(callback, { success: false, error: 'Invalid room name' });
		if (!allowedRoomsFor(socket, settings).includes(room)) return respond(callback, { success: false, error: 'Room access denied' });
		void socket.join(room);
		respond(callback, { success: true, room });
	});

	socket.on('leave-room', (room, callback) => {
		if (!isValidRoom(room)) return respond(callback, { success: false, error: 'Invalid room name' });
		if (!allowedRoomsFor(socket, settings).includes(room)) return respond(callback, { success: false, error: 'Room access denied' });
		void socket.leave(room);
		respond(callback, { success: true, room });
	});

	socket.on('get-rooms', (callback) => {
		const rooms = Array.from(socket.rooms).filter((room) => room !== socket.id);
		respond(callback, { success: true, rooms });
	});

	socket.on('private-message', (payload, callback) => {
		const target = typeof payload?.to === 'string' ? io.sockets.sockets.get(payload.to) : null;
		const message = payload?.message;
		if (!socket.user?.id || !target?.user?.id || socket.userRole !== target.userRole) {
			return respond(callback, { success: false, error: 'Message access denied' });
		}
		if (typeof message !== 'string' || message.length === 0 || message.length > MAX_MESSAGE_LENGTH) {
			return respond(callback, { success: false, error: 'Invalid message' });
		}
		io.to(target.id).emit('private-message', { message, timestamp: Date.now() });
		respond(callback, { success: true });
	});
}

function sanitizeMonitoringSnapshot(snapshot) {
	return {
		connected: Number.isFinite(snapshot?.connected) ? snapshot.connected : 0,
		rooms: (snapshot?.rooms || []).map((room) => ({
			members: Number.isFinite(room.members) ? room.members : 0,
			isEntityRoom: Boolean(room.isEntityRoom),
		})),
		sockets: (snapshot?.sockets || []).map((socket) => ({
			connected: Boolean(socket.connected),
			roomCount: Array.isArray(socket.rooms) ? socket.rooms.length : 0,
			authenticated: Boolean(socket.user?.id),
		})),
		entitySubscriptions: {
			total: Number.isFinite(snapshot?.entitySubscriptions?.total) ? snapshot.entitySubscriptions.total : 0,
			byContentType: Object.fromEntries(Object.entries(snapshot?.entitySubscriptions?.byContentType || {})
				.map(([uid, count]) => [uid.split('::').pop()?.split('.')[0] || 'other', count])),
		},
	};
}

function validateEntitySubscriptionInput(payload) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
	const { uid, id } = payload;
	if (typeof uid !== 'string' || uid.length > 128 || !/^(api|plugin)::[a-z0-9-]+\.[a-z0-9-]+$/.test(uid)) return null;
	if (typeof id === 'number') return Number.isSafeInteger(id) && id > 0 ? { uid, id } : null;
	if (typeof id !== 'string' || id.length === 0 || id.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;
	if (/^\d+$/.test(id) && (!Number.isSafeInteger(Number(id)) || Number(id) < 1)) return null;
	return { uid, id };
}

function sanitizeTestEventData(data) {
	if (!data || typeof data !== 'object' || Array.isArray(data)
		|| (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null)) {
		throw new Error('Test event data must be an object');
	}
	if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 8192) throw new Error('Test event data is too large');
	const sensitiveKey = /(password|token|secret|api.?key|credential|authorization|cookie|email|phone)/i;
	const sanitize = (value, depth = 0) => {
		if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
		if (typeof value === 'string') return value.slice(0, 2048);
		if (depth >= 5) return '[omitted]';
		if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
		if (!value || typeof value !== 'object') return undefined;
		return Object.fromEntries(Object.entries(value)
			.filter(([key]) => !sensitiveKey.test(key))
			.slice(0, 100)
			.map(([key, nested]) => [key, sanitize(nested, depth + 1)])
			.filter(([, nested]) => nested !== undefined));
	};
	return sanitize(data);
}

module.exports = {
	buildCorsOptions,
	createHandshakeMiddleware,
	registerRoomAccessHandlers,
	sanitizeMonitoringSnapshot,
	validateEntitySubscriptionInput,
	sanitizeTestEventData,
};

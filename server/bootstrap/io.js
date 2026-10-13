'use strict';

const { SocketIO } = require('../structures');
const { pluginId } = require('../utils/pluginId');
const {
	buildCorsOptions,
	createHandshakeMiddleware,
	registerRoomAccessHandlers,
	validateEntitySubscriptionInput,
} = require('../utils/socket-security');

async function bootstrapIO({ strapi }) {
	const settingsService = strapi.plugin(pluginId).service('settings');
	const settings = await settingsService.getSettings();
	const monitoringService = strapi.plugin(pluginId).service('monitoring');

	const serverOptions = {
		cors: buildCorsOptions(settings),
		pingTimeout: settings.connection?.pingTimeout || 20000,
		pingInterval: settings.connection?.pingInterval || 25000,
		connectTimeout: settings.connection?.connectionTimeout || 45000,
		maxHttpBufferSize: 1e6,
		transports: ['websocket', 'polling'],
		allowEIO3: true,
	};

	// Redis Adapter for multi-server scaling
	if (settings.redis?.enabled) {
		try {
			const { createAdapter } = require('@socket.io/redis-adapter');
			const { createClient } = require('redis');
			
			const pubClient = createClient({
				url: settings.redis.url || 'redis://localhost:6379',
			});
			const subClient = pubClient.duplicate();

			await Promise.all([pubClient.connect(), subClient.connect()]);
			
			serverOptions.adapter = createAdapter(pubClient, subClient);
			strapi.log.info('socket.io: Redis adapter enabled');
		} catch {
			strapi.log.error('socket.io: Redis adapter failed');
		}
	}

	const io = new SocketIO(serverOptions);
	strapi.$io = io;
	strapi.$ioSettings = settings;

	// Apply sensitive fields sanitization middleware
	const sanitizeSensitiveFields = require('../src/middlewares/sanitize-sensitive-fields');
	sanitizeSensitiveFields({ strapi });

	// Namespaces
	const namespaces = {
		main: io.server,
	};

	if (settings.namespaces?.enabled) {
		Object.entries(settings.namespaces.list || {}).forEach(([name, config]) => {
			const nsp = io.server.of(`/${name}`);
			namespaces[name] = nsp;

			// Namespace-specific authentication middleware
			if (config.requireAuth) {
				nsp.use(async (socket, next) => {
					if (!socket.user) {
						strapi.log.warn(`socket.io: Authentication required for namespace /${name}, connection denied`);
						return next(new Error(`Authentication required for namespace /${name}`));
					}
					strapi.log.debug(`socket.io: Authenticated access to namespace /${name}`);
					next();
				});
			}

			strapi.log.info(`socket.io: Namespace created - /${name} (requireAuth: ${config.requireAuth || false})`);
		});
	}

	strapi.$io.namespaces = namespaces;

	// A supplied but invalid token must never fall back to public access.
	io.server.use(createHandshakeMiddleware({ settings, io: io.server, strapi }));

	// Custom Middleware
	if (settings.middleware?.enabled && Array.isArray(settings.middleware.handlers)) {
		settings.middleware.handlers.forEach((handler) => {
			if (typeof handler === 'function') {
				io.server.use(handler);
			}
		});
	}

	// Connection Handler
	io.server.on('connection', (socket) => {
		const username = socket.user ? 'authenticated' : 'anonymous';
		
		if (settings.monitoring?.enableConnectionLogging) {
			strapi.log.info(`socket.io: Client connected (user: ${username})`);
			monitoringService.logEvent('connection', { 
				authenticated: Boolean(socket.user),
			});
		}

		registerRoomAccessHandlers(socket, { settings, io: io.server });

		// Entity Subscription (NEW - for entity-specific events)
		socket.on('subscribe-entity', async (payload, callback) => {
			const identity = validateEntitySubscriptionInput(payload);
			if (!identity) {
				if (callback) callback({ success: false, error: 'Invalid entity subscription' });
				return;
			}
			const { uid, id } = identity;
			// Check if entity subscriptions are enabled
			if (settings.entitySubscriptions?.enabled === false) {
				if (callback) callback({ success: false, error: 'Entity subscriptions are disabled' });
				return;
			}

			// Validate parameters
			if (!uid || !id) {
				if (callback) callback({ success: false, error: 'Invalid parameters: uid and id are required' });
				return;
			}

			// Validate uid format (api::model.model or plugin::plugin.model)
			if (typeof uid !== 'string' || !uid.match(/^(api|plugin)::[a-z0-9-]+\.[a-z0-9-]+$/)) {
				if (callback) callback({ success: false, error: 'Invalid content type uid format' });
				return;
			}

			// Validate id (must be number or string)
			if (typeof id !== 'number' && typeof id !== 'string') {
				if (callback) callback({ success: false, error: 'Invalid entity id' });
				return;
			}

			// Check if content type is in allowedContentTypes whitelist (if not empty)
			if (settings.entitySubscriptions?.allowedContentTypes?.length > 0) {
				if (!settings.entitySubscriptions.allowedContentTypes.includes(uid)) {
					if (callback) callback({ success: false, error: 'Content type not allowed for entity subscriptions' });
					return;
				}
			}

			// Check max subscriptions per socket
			const currentSubs = Array.from(socket.rooms).filter(r => r !== socket.id && r.includes(':')).length;
			const configuredMaxSubs = settings.entitySubscriptions?.maxSubscriptionsPerSocket;
			const maxSubs = Number.isInteger(configuredMaxSubs) ? Math.max(0, Math.min(configuredMaxSubs, 500)) : 100;
			if (currentSubs >= maxSubs) {
				if (callback) callback({ success: false, error: `Maximum subscriptions (${maxSubs}) reached` });
				return;
			}

			// Check if content type exists
			const contentType = strapi.contentTypes[uid];
			if (!contentType) {
				if (callback) callback({ success: false, error: 'Content type not found' });
				return;
			}

			// Check if user has permission to read this content type
			const userRole = socket.user?.role?.toLowerCase() || 'public';
			const rolePermissions = settings.rolePermissions?.[userRole] || settings.rolePermissions?.['public'] || {};
			const contentTypePerms = rolePermissions.contentTypes?.[uid];

			// If no explicit permission, deny by default
			if (!contentTypePerms || (!contentTypePerms.create && !contentTypePerms.update && !contentTypePerms.delete)) {
				if (callback) callback({ success: false, error: 'Permission denied: no access to this content type' });
				return;
			}

			// Verify entity exists (optional, based on settings)
			if (settings.entitySubscriptions?.requireVerification !== false) {
				try {
					// Use Document Service API (Strapi v5)
					// Try documentId first, then fall back to numeric id filter
					let entity = null;
					if (id && !/^\d+$/.test(String(id))) {
						// Looks like a documentId
						entity = await strapi.documents(uid).findOne({ documentId: id });
					} else {
						// Numeric id - use findFirst with filter
						const results = await strapi.documents(uid).findMany({
							filters: { id: Number(id) },
							limit: 1,
						});
						entity = results.length > 0 ? results[0] : null;
					}
					if (!entity) {
						if (callback) callback({ success: false, error: 'Entity not found' });
						return;
					}
				} catch {
					strapi.log.warn('socket.io: Entity verification failed');
					if (callback) callback({ success: false, error: 'Entity verification failed' });
					return;
				}
			}

			// Join entity-specific room
			const entityRoomName = `${uid}:${id}`;
			socket.join(entityRoomName);
			
			// Track metrics if enabled
			if (settings.entitySubscriptions?.enableMetrics && settings.monitoring?.enableEventLogging) {
				monitoringService.logEvent('entity-subscribe', {
					socketId: socket.id,
					uid,
					id,
					user: socket.user || null,
				});
			}
			
			strapi.log.debug('socket.io: Entity subscription accepted');
			if (callback) callback({ success: true, room: entityRoomName, uid, id });
		});

		socket.on('unsubscribe-entity', (payload, callback) => {
			const identity = validateEntitySubscriptionInput(payload);
			if (!identity) {
				if (callback) callback({ success: false, error: 'Invalid entity subscription' });
				return;
			}
			const { uid, id } = identity;
			// Check if entity subscriptions are enabled
			if (settings.entitySubscriptions?.enabled === false) {
				if (callback) callback({ success: false, error: 'Entity subscriptions are disabled' });
				return;
			}

			// Validate parameters
			if (!uid || !id) {
				if (callback) callback({ success: false, error: 'Invalid parameters: uid and id are required' });
				return;
			}

			const entityRoomName = `${uid}:${id}`;
			socket.leave(entityRoomName);
			
			// Track metrics if enabled
			if (settings.entitySubscriptions?.enableMetrics && settings.monitoring?.enableEventLogging) {
				monitoringService.logEvent('entity-unsubscribe', {
					socketId: socket.id,
					uid,
					id,
					user: socket.user || null,
				});
			}
			
			strapi.log.debug('socket.io: Entity subscription removed');
			if (callback) callback({ success: true, room: entityRoomName, uid, id });
		});

		// Get Entity Subscriptions
		socket.on('get-entity-subscriptions', (callback) => {
			const rooms = Array.from(socket.rooms)
				.filter((r) => r !== socket.id && r.includes(':'))
				.map((room) => {
					const [uid, id] = room.split(':');
					return { uid, id, room };
				});
			
			if (callback) callback({ success: true, subscriptions: rooms });
		});

		// Disconnect Handler
		socket.on('disconnect', (reason) => {
			if (settings.monitoring?.enableConnectionLogging) {
				strapi.log.info(`socket.io: Client disconnected (user: ${username})`);
				monitoringService.logEvent('disconnect', {
					reason: ['client namespace disconnect', 'server namespace disconnect', 'ping timeout', 'transport close'].includes(reason) ? reason : 'unknown',
					authenticated: Boolean(socket.user),
				});
			}
		});

		// Error Handler
		socket.on('error', () => {
			strapi.log.error('socket.io: Socket error');
			monitoringService.logEvent('error', { 
				error: 'socket-error',
				authenticated: Boolean(socket.user),
			});
		});
	});

	// Rate Limiting
	if (settings.security?.rateLimiting?.enabled) {
		const eventCounts = new Map();
		const maxEvents = settings.security.rateLimiting.maxEventsPerSecond || 10;

		io.server.on('connection', (socket) => {
			eventCounts.set(socket.id, { count: 0, resetAt: Date.now() + 1000 });

			socket.use((packet, next) => {
				const now = Date.now();
				const data = eventCounts.get(socket.id);

				if (now > data.resetAt) {
					data.count = 0;
					data.resetAt = now + 1000;
				}

				data.count++;

				if (data.count > maxEvents) {
					return next(new Error('Rate limit exceeded'));
				}

				next();
			});

			socket.on('disconnect', () => {
				eventCounts.delete(socket.id);
			});
		});
	}

	// Helper Functions
	strapi.$io.joinRoom = (socketId, roomName) => {
		const socket = io.server.sockets.sockets.get(socketId);
		if (socket) {
			socket.join(roomName);
			return true;
		}
		return false;
	};

	strapi.$io.leaveRoom = (socketId, roomName) => {
		const socket = io.server.sockets.sockets.get(socketId);
		if (socket) {
			socket.leave(roomName);
			return true;
		}
		return false;
	};

	strapi.$io.getSocketsInRoom = async (roomName) => {
		const sockets = await io.server.in(roomName).fetchSockets();
		return sockets.map((s) => ({
			id: s.id,
			user: s.user || null,
		}));
	};

	strapi.$io.sendPrivateMessage = (socketId, event, data) => {
		io.server.to(socketId).emit(event, data);
	};

	strapi.$io.broadcast = (socketId, event, data) => {
		const socket = io.server.sockets.sockets.get(socketId);
		if (socket) {
			socket.broadcast.emit(event, data);
		}
	};

	strapi.$io.emitToNamespace = (namespace, event, data) => {
		const nsp = namespaces[namespace];
		if (nsp) {
			nsp.emit(event, data);
		}
	};

	strapi.$io.disconnectSocket = (socketId) => {
		const socket = io.server.sockets.sockets.get(socketId);
		if (socket) {
			socket.disconnect(true);
			return true;
		}
		return false;
	};

	// Entity Subscription Helpers
	strapi.$io.subscribeToEntity = async (socketId, uid, id) => {
		const socket = io.server.sockets.sockets.get(socketId);
		if (!socket) {
			return { success: false, error: 'Socket not found' };
		}

		// Validate content type
		const contentType = strapi.contentTypes[uid];
		if (!contentType) {
			return { success: false, error: 'Content type not found' };
		}

		// Join entity room
		const entityRoomName = `${uid}:${id}`;
		socket.join(entityRoomName);
		
		strapi.log.debug(`socket.io: Helper subscribed socket ${socketId} to entity: ${entityRoomName}`);
		return { success: true, room: entityRoomName, uid, id };
	};

	strapi.$io.unsubscribeFromEntity = (socketId, uid, id) => {
		const socket = io.server.sockets.sockets.get(socketId);
		if (!socket) {
			return { success: false, error: 'Socket not found' };
		}

		const entityRoomName = `${uid}:${id}`;
		socket.leave(entityRoomName);
		
		strapi.log.debug(`socket.io: Helper unsubscribed socket ${socketId} from entity: ${entityRoomName}`);
		return { success: true, room: entityRoomName, uid, id };
	};

	strapi.$io.getEntitySubscriptions = (socketId) => {
		const socket = io.server.sockets.sockets.get(socketId);
		if (!socket) {
			return { success: false, error: 'Socket not found' };
		}

		const subscriptions = Array.from(socket.rooms)
			.filter((r) => r !== socket.id && r.includes(':'))
			.map((room) => {
				const parts = room.split(':');
				// Handle both formats: "api::article.article:123" and simple "article:123"
				if (parts.length >= 3) {
					const uid = parts.slice(0, -1).join(':');
					const id = parts[parts.length - 1];
					return { uid, id, room };
				}
				return null;
			})
			.filter(Boolean);

		return { success: true, subscriptions };
	};

	strapi.$io.emitToEntity = (uid, id, event, data) => {
		const entityRoomName = `${uid}:${id}`;
		io.server.to(entityRoomName).emit(event, data);
		strapi.log.debug(`socket.io: Emitted '${event}' to entity room: ${entityRoomName}`);
	};

	strapi.$io.getEntityRoomSockets = async (uid, id) => {
		const entityRoomName = `${uid}:${id}`;
		const sockets = await io.server.in(entityRoomName).fetchSockets();
		return sockets.map((s) => ({
			id: s.id,
			user: s.user || null,
		}));
	};

	// Count enabled content types
	const allContentTypes = new Set();
	Object.values(settings.rolePermissions || {}).forEach((rolePerms) => {
		if (rolePerms.contentTypes) {
			Object.entries(rolePerms.contentTypes).forEach(([uid, actions]) => {
				if (actions.create || actions.update || actions.delete) {
					allContentTypes.add(uid);
				}
			});
		}
	});
	const enabledContentTypes = allContentTypes.size;

	const origins = settings.cors?.origins?.join(', ') || 'http://localhost:3000';
	const features = [];
	if (settings.redis?.enabled) features.push('Redis');
	if (settings.namespaces?.enabled) features.push(`Namespaces(${Object.keys(settings.namespaces.list || {}).length})`);
	if (settings.security?.rateLimiting?.enabled) features.push('RateLimit');
	
	strapi.log.info(`socket.io: Plugin initialized`);
	strapi.log.info(`  • Origins: ${origins}`);
	strapi.log.info(`  • Content Types: ${enabledContentTypes}`);
	strapi.log.info(`  • Max Connections: ${settings.connection?.maxConnections || 1000}`);
	if (features.length > 0) {
		strapi.log.info(`  • Features: ${features.join(', ')}`);
	}
}

module.exports = { bootstrapIO };

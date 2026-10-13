'use strict';

const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');
const { SocketIO } = require('../server/structures/SocketIO');
const { plugin: pluginConfigSchema } = require('../server/config/schema');
const {
	buildCorsOptions,
	createHandshakeMiddleware,
	registerRoomAccessHandlers,
	sanitizeMonitoringSnapshot,
	sanitizeTestEventData,
	validateEntitySubscriptionInput,
} = require('../server/utils/socket-security');
const createMonitoringService = require('../server/services/monitoring');
const createStrategyService = require('../server/services/strategies');

let httpServer;
let ioServer;
let baseUrl;
const clients = new Set();

before(async () => {
	httpServer = http.createServer();
	ioServer = new Server(httpServer, { cors: buildCorsOptions({ cors: { origins: ['https://app.example.test'] } }) });
	const strapi = {
		plugin: () => ({ service: () => ({ verify: async (token) => {
			if (token !== 'valid-test-token') throw new Error('invalid token');
			return { id: 7 };
		} }) }),
		documents: () => ({ findMany: async () => [{ id: 7, username: 'tester', role: { name: 'authenticated' } }] }),
		log: { warn() {}, info() {}, debug() {} },
	};
	ioServer.use(createHandshakeMiddleware({
		settings: {
			security: { requireAuthentication: false },
			connection: { maxConnections: 10 },
			rolePermissions: { public: { canConnect: true }, authenticated: { canConnect: true } },
			rooms: { autoJoinByRole: { public: ['lobby'], authenticated: ['members'] } },
		},
		io: ioServer,
		strapi,
	}));
	ioServer.on('connection', (socket) => registerRoomAccessHandlers(socket, {
		settings: {
			rooms: {
				enablePrivateRooms: true,
				autoJoinByRole: { public: ['lobby'], authenticated: ['members'] },
			},
		},
		io: ioServer,
		strapi,
	}));
	await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
	for (const client of clients) client.disconnect();
	await new Promise((resolve) => ioServer.close(resolve));
});

function connect(auth = {}) {
	const client = createClient(baseUrl, { auth, transports: ['websocket'], reconnection: false, timeout: 1000 });
	clients.add(client);
	return client;
}

function emitAck(client, event, payload) {
	return new Promise((resolve, reject) => {
		const acknowledge = (error, result) => error ? reject(error) : resolve(result);
		if (payload === undefined) client.timeout(1000).emit(event, acknowledge);
		else client.timeout(1000).emit(event, payload, acknowledge);
	});
}

function connected(client) {
	return new Promise((resolve, reject) => {
		client.once('connect', resolve);
		client.once('connect_error', reject);
	});
}

test('handshake rejects invalid supplied credentials instead of downgrading to public', async () => {
	const client = connect({ token: 'invalid-test-token' });
	await assert.rejects(connected(client), /Authentication failed/);
});

test('handshake assigns the authenticated socket to its role room', async () => {
	const client = connect({ token: 'valid-test-token' });
	await connected(client);
	const result = await emitAck(client, 'get-rooms');
	assert.deepEqual(result, { success: true, rooms: ['members'] });
});

test('query-string credentials do not satisfy required authentication', async () => {
	const middleware = createHandshakeMiddleware({
		settings: { security: { requireAuthentication: true }, connection: { maxConnections: 10 } },
		io: ioServer,
		strapi: { plugin() { throw new Error('query token must not be verified'); } },
	});
	const socket = { handshake: { address: '127.0.0.1', auth: {}, query: { token: 'valid-test-token' } }, join() {} };
	const error = await new Promise((resolve) => middleware(socket, resolve));
	assert.equal(error.message, 'Authentication required');
});

test('room membership is limited to rooms configured for the socket role', async () => {
	const client = connect();
	await connected(client);
	assert.equal((await emitAck(client, 'join-room', 'lobby')).success, true);
	assert.deepEqual(await emitAck(client, 'join-room', 'members'), { success: false, error: 'Room access denied' });
	assert.deepEqual(await emitAck(client, 'join-room', 'anything-else'), { success: false, error: 'Room access denied' });
});

test('room names and message payloads have strict bounds', async () => {
	const client = connect({ token: 'valid-test-token' });
	const recipient = connect({ token: 'valid-test-token' });
	await Promise.all([connected(client), connected(recipient)]);
	assert.deepEqual(await emitAck(client, 'join-room', 'x'.repeat(129)), { success: false, error: 'Invalid room name' });
	assert.deepEqual(await emitAck(client, 'private-message', { to: recipient.id, message: 'x'.repeat(2001) }), { success: false, error: 'Invalid message' });
});

test('private-message requires authenticated same-role participants', async () => {
	const sender = connect();
	const recipient = connect({ token: 'valid-test-token' });
	await Promise.all([connected(sender), connected(recipient)]);
	assert.deepEqual(await emitAck(sender, 'private-message', { to: recipient.id, message: 'hello' }), { success: false, error: 'Message access denied' });
});

test('private-message is delivered only after same-role authentication succeeds', async () => {
	const sender = connect({ token: 'valid-test-token' });
	const recipient = connect({ token: 'valid-test-token' });
	await Promise.all([connected(sender), connected(recipient)]);
	const received = new Promise((resolve) => recipient.once('private-message', resolve));
	assert.deepEqual(await emitAck(sender, 'private-message', { to: recipient.id, message: 'hello' }), { success: true });
	const payload = await received;
	assert.equal(payload.message, 'hello');
	assert.equal(typeof payload.timestamp, 'number');
	assert.equal('from' in payload, false);
});

test('entity-specific rooms cannot bypass role-based event authorization', async () => {
	const originalStrapi = global.strapi;
	const httpServer = http.createServer();
	global.strapi = {
		server: { httpServer },
		contentAPI: { permissions: { engine: { generateAbility: async () => ({ can: () => true }) } } },
		service(uid) {
			if (uid === 'plugin::io.sanitize') return { output: async ({ data }) => data };
			if (uid === 'plugin::io.strategy') {
				return {
					role: {
						name: 'io-role',
						getRooms: async () => [{ name: 'public', permissions: [{ action: 'api::article.article.update' }] }],
						getRoomName: () => 'io-role-public',
					},
					token: { getRooms: async () => [] },
				};
			}
			if (uid === 'plugin::io.transform') return { response: ({ data }) => data };
			throw new Error(`Unexpected service: ${uid}`);
		},
	};

	const socketIO = new SocketIO({ serveClient: false });
	const emittedRooms = [];
	socketIO.server.to = (room) => ({ emit: () => emittedRooms.push(room) });
	try {
		await socketIO.emit({
			event: 'update',
			schema: { singularName: 'article', uid: 'api::article.article', attributes: {} },
			data: { id: 42, title: 'private update' },
		});
		assert.deepEqual(emittedRooms, ['io-role-public']);
	} finally {
		await new Promise((resolve) => socketIO.server.close(resolve));
		if (originalStrapi === undefined) delete global.strapi;
		else global.strapi = originalStrapi;
	}
});

test('CORS rejects wildcard origins and limits methods to known HTTP verbs', () => {
	const options = buildCorsOptions({ cors: { origins: ['*', 'https://app.example.test', 'ftp://app.example.test'], methods: ['GET', 'TRACE', 'POST'], credentials: true } });
	assert.deepEqual(options.origin, ['https://app.example.test']);
	assert.deepEqual(options.methods, ['GET', 'POST']);
	assert.equal(options.credentials, true);
});

test('monitoring snapshots omit handshake credentials and personally identifying values', () => {
	const snapshot = sanitizeMonitoringSnapshot({
		connected: 1,
		rooms: [{ name: 'api::private-record:123', members: 1, isEntityRoom: true }],
		sockets: [{
			id: 'secret-socket-id', connected: true, rooms: ['api::private-record:123'],
			handshake: { address: '192.0.2.10', query: { token: 'secret-token' } },
			user: { id: 7, username: 'tester', email: 'person@example.test' },
		}],
	});
	const serialized = JSON.stringify(snapshot);
	for (const value of ['secret-socket-id', '192.0.2.10', 'secret-token', 'person@example.test', 'private-record', 'tester']) {
		assert.equal(serialized.includes(value), false, `monitoring leaked ${value}`);
	}
	assert.deepEqual(snapshot.sockets, [{ connected: true, roomCount: 1, authenticated: true }]);
});

test('entity subscription identifiers reject oversized and unsafe values', () => {
	assert.equal(validateEntitySubscriptionInput({ uid: 'api::article.article', id: 'doc_1' }).id, 'doc_1');
	assert.equal(validateEntitySubscriptionInput({ uid: 'api::article.article', id: '9'.repeat(40) }), null);
	assert.equal(validateEntitySubscriptionInput({ uid: 'api::article.article', id: '../secret' }), null);
	assert.equal(validateEntitySubscriptionInput({ uid: 'api::article.article', id: 1.5 }), null);
});

test('monitoring event logs keep aggregate fields and reject unbounded test event names', () => {
	const strapi = {
		$ioSettings: { monitoring: { enableEventLogging: true, maxEventLogSize: 10 } },
		$io: { server: { sockets: { sockets: new Map() } } },
	};
	strapi.$io.server.emit = () => {};
	const monitoring = createMonitoringService({ strapi });
	monitoring.logEvent('connection', { authenticated: true, token: 'secret', email: 'person@example.test', socketId: 'private-id' });
	const [entry] = monitoring.getEventLog();
	assert.equal(entry.type, 'connection');
	assert.deepEqual(entry.data, { authenticated: true });
	assert.equal(JSON.stringify(entry).includes('secret'), false);
	assert.equal(JSON.stringify(entry).includes('person@example.test'), false);
	assert.equal(JSON.stringify(entry).includes('private-id'), false);
	assert.throws(() => monitoring.sendTestEvent('bad event name'), /Invalid test event name/);
	const result = monitoring.sendTestEvent('test.safe', {
		message: 'hello',
		accessToken: 'secret-token',
		profile: { email: 'person@example.test' },
	});
	assert.equal(result.data.message, 'hello');
	assert.equal(JSON.stringify(result.data).includes('secret-token'), false);
	assert.equal(JSON.stringify(result.data).includes('person@example.test'), false);
	assert.deepEqual(monitoring.getEventLog(-1), []);
});

test('test event data has object, depth, array and byte bounds', () => {
	assert.throws(() => sanitizeTestEventData(['nope']), /must be an object/);
	assert.throws(() => sanitizeTestEventData({ payload: 'x'.repeat(8200) }), /too large/);
	assert.equal(sanitizeTestEventData({ values: Array.from({ length: 55 }, (_, index) => index) }).values.length, 50);
});

test('Strapi plugin config accepts its function hooks under the current Zod schema', () => {
	const configuration = {
		contentTypes: [],
		events: [{ name: 'ready', handler: () => {} }],
		hooks: { init: () => {} },
		socket: { serverOptions: { maxHttpBufferSize: 1024 } },
	};
	assert.equal(pluginConfigSchema.parse(configuration).events[0].name, 'ready');
	assert.throws(() => pluginConfigSchema.parse({ ...configuration, events: [{ name: 'ready', handler: 'not a function' }] }));
});

test('read-only API tokens are limited to find and findOne scopes', () => {
	const originalStrapi = global.strapi;
	const fakeStrapi = {
		service: () => ({ hash: () => 'hashed' }),
	};
	global.strapi = fakeStrapi;
	try {
		const tokenStrategy = createStrategyService({ strapi: fakeStrapi }).token;
		const auth = { credentials: { type: 'read-only' }, ability: {} };
		assert.doesNotThrow(() => tokenStrategy.verify(auth, { scope: 'api::article.article.find' }));
		assert.doesNotThrow(() => tokenStrategy.verify(auth, { scope: 'api::article.article.findOne' }));
		assert.throws(() => tokenStrategy.verify(auth, { scope: 'api::article.article.update' }));
	} finally {
		if (originalStrapi === undefined) delete global.strapi;
		else global.strapi = originalStrapi;
	}
});

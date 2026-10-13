# strapi-plugin-io

A plugin for [Strapi CMS](https://github.com/strapi/strapi) that provides the ability for [Socket IO](https://socket.io) integration.

> **Fork notice:** This checkout is the [Schero94 fork](https://github.com/Schero94/strapi-plugin-io). The public [strapi-plugin-io npm package](https://www.npmjs.com/package/strapi-plugin-io) belongs to the upstream [ComfortablyCoding repository](https://github.com/ComfortablyCoding/strapi-plugin-io). Installing the npm package installs upstream code. This fork publishes GitHub releases only and does not publish to npm.

**Fork documentation:** [https://schero94.github.io/strapi-plugin-io/](https://schero94.github.io/strapi-plugin-io/)

[![Downloads](https://img.shields.io/npm/dm/strapi-plugin-io?style=for-the-badge)](https://img.shields.io/npm/dm/strapi-plugin-io?style=for-the-badge)
[![Install size](https://img.shields.io/npm/l/strapi-plugin-io?style=for-the-badge)](https://img.shields.io/npm/l/strapi-plugin-io?style=for-the-badge)
[![Fork release](https://img.shields.io/github/v/release/Schero94/strapi-plugin-io?style=for-the-badge)](https://github.com/Schero94/strapi-plugin-io/releases)

## Requirements

The installation requirements are the same as Strapi itself and can be found in the documentation on the [Quick Start](https://strapi.io/documentation/developer-docs/latest/getting-started/quick-start.html) page in the Prerequisites info card. This checkout requires Node.js 22 and npm 10, and its Strapi peer dependency is <code>@strapi/strapi ^5.57.0</code>.

### Supported Strapi versions

- **v5.x.x** (Current version)
- v4.x.x (Legacy; see older versions)

**NOTE**: This version (v3.x.x+) is for Strapi v5. For Strapi v4, use version 2.x.x of the upstream plugin. This checkout is the Schero94 fork, and the npm package instructions below refer to the upstream package only.

## Installation

The public npm package is upstream-owned. The following commands install the upstream package, not this fork:

~~~sh
npm install strapi-plugin-io

# or

yarn add strapi-plugin-io
~~~

To work with this fork, clone it, build it, and install its local package directory into your Strapi application:

~~~sh
git clone https://github.com/Schero94/strapi-plugin-io.git
cd strapi-plugin-io
npm ci
npm run build

# From the Strapi application directory:
npm install --save file:../strapi-plugin-io
~~~

## Configuration

### Basic setup

Enable the plugin in your Strapi config file: <code>config/plugins.js</code> or <code>config/plugins.ts</code>. Choose content-type actions and role permissions in the plugin's Settings → Socket.IO admin page.

~~~javascript
module.exports = ({ env }) => ({
  io: {
    enabled: true,
  },
});
~~~

Runtime CORS and connection options, enabled content-type actions, and room permissions are read from the plugin's stored settings. The config schema still accepts legacy <code>contentTypes</code>, <code>events</code>, <code>hooks</code>, and <code>socket</code> fields, but the current bootstrap does not apply those fields.

### Authentication

Socket connections can use a JWT issued by Strapi's users-permissions plugin. Send it through the Socket.IO auth payload. A missing token creates an anonymous connection unless authentication is required in plugin settings. Invalid supplied credentials are rejected.

~~~javascript
import { io } from 'socket.io-client';

const socket = io('https://cms.example.com', {
  auth: {
    token: usersPermissionsJwt,
  },
});

socket.on('article:create', (data) => {
  console.log('New article created:', data);
});

socket.on('article:update', (data) => {
  console.log('Article updated:', data);
});

socket.on('article:delete', (data) => {
  console.log('Article deleted:', data);
});
~~~

Do not send credentials in a query string. The current fork's active handshake validates JWTs. Do not rely on API-token socket authentication.

## Usage

### Quick start

The Socket.IO server is available as <code>strapi.$io</code> after plugin bootstrap.

~~~javascript
// Emit a custom event to all root-namespace clients
strapi.$io.raw({
  event: 'notification',
  data: { message: 'Hello World!' },
});

// Send an event to a socket from server-side code
strapi.$io.sendPrivateMessage(socketId, 'notification', {
  type: 'info',
  message: 'Payment processed',
});

// Emit to a configured namespace. The root namespace is named "main".
strapi.$io.emitToNamespace('main', 'dashboard:update', {
  stats: { users: 1234, active: 56 },
});

// Emit to an entity room from server-side code
strapi.$io.emitToEntity('api::article.article', 'article-document-id', 'article:viewed', {
  views: 1500,
});

// Read current connection statistics
const monitoringService = strapi.plugin('io').service('monitoring');
const stats = monitoringService.getConnectionStats();
console.log(stats.connected);
~~~

Server-side helper calls such as <code>raw</code>, <code>sendPrivateMessage</code>, and <code>emitToEntity</code> do not apply application-specific authorization. Check access before using them with private data.

Other available helpers include <code>broadcast(socketId, event, data)</code>, <code>disconnectSocket(socketId)</code>, <code>subscribeToEntity(socketId, uid, id)</code>, <code>unsubscribeFromEntity(socketId, uid, id)</code>, <code>getEntitySubscriptions(socketId)</code>, and <code>getEntityRoomSockets(uid, id)</code>. Programmatic entity subscriptions do not apply the client's role-permission checks, so authorize them in server code.

### Entity-specific subscriptions

Clients can request a subscription to an entity room:

~~~javascript
socket.emit('subscribe-entity', {
  uid: 'api::article.article',
  id: 'article-document-id',
}, (response) => {
  if (response.success) {
    console.log('Subscribed to:', response.room);
  }
});
~~~

The server validates the identifier and content type, checks that the role has configured content-type permissions, and verifies that the entity exists by default. The default limit is 100 subscriptions per socket, with a hard cap of 500. Use <code>unsubscribe-entity</code> to leave the room.

Subscribing places the socket in an entity room. It does not redirect automatic create or update lifecycle events to that room. Server code can explicitly emit to the room with <code>strapi.$io.emitToEntity(uid, id, event, data)</code>; callers must authorize that operation.

When server code targets these rooms, clients receive only the entity-specific events sent to rooms they joined. This can reduce unrelated event traffic. Subscription requests are subject to the configured role permissions and entity checks described above.

### Room management

Configure room names for each role in Settings → Socket.IO. A client can join or leave only a room allowed for its role.

~~~javascript
socket.emit('join-room', 'members', (response) => {
  if (!response.success) console.error(response.error);
});

const sockets = await strapi.$io.getSocketsInRoom('members');
console.log(sockets.length);

strapi.$io.server.to('members').emit('exclusive-offer', data);
~~~

### Admin panel configuration

Open **Settings → Socket.IO** to configure the plugin.

- **CORS origins** control which browser origins may connect.
- **Role permissions** control connection access and content-type actions.
- **Security settings** include required authentication, rate limiting, and IP allowlists or blocklists.
- **Event settings** expose content-type actions and options for custom names, relations, exclusions, and publication status.
- **Redis adapter** enables cross-instance Socket.IO broadcasts.
- **Namespaces** create separate communication channels.
- **Monitoring** displays active connections, rooms, event totals, and events per second.

The admin page exposes the event options above. In the current lifecycle implementation, enabled actions come from role permissions and event names remain <code>singularName:action</code>; the custom-name, relation, exclusion, and published-only settings are not applied. The admin dashboard widget displays connection, room, and event statistics provided by the monitoring endpoint.

### Content-type events

Enable content-type actions and role permissions in the admin page, then listen for the event names on the client:

~~~javascript
socket.on('article:create', (article) => {
  console.log('New article:', article);
});

socket.on('article:update', (article) => {
  console.log('Updated article:', article);
});

socket.on('article:delete', (article) => {
  console.log('Deleted article:', article.id);
});
~~~

Create and update events pass through the plugin's permission and sanitization flow. **Current fork limitation:** delete events send the record's <code>id</code> and <code>documentId</code> through <code>strapi.$io.raw()</code> to all connected clients on the root namespace. This path does not apply the create/update role-room authorization. Do not enable delete events for sensitive content until that behavior has been reviewed or changed.

## TypeScript support

The package includes TypeScript declarations in <code>types.d.ts</code> for plugin configuration and Socket.IO interfaces. The declarations are not mapped through a package <code>./types</code> export, so check the package export map when wiring them into a consuming application's TypeScript configuration.

## Dashboard widget

The plugin includes a live statistics widget on the Strapi admin home page. It displays active connections, active rooms, event totals, and events per second, and polls the monitoring endpoint every 60 seconds. Open the admin home page after installing and enabling the plugin.

## Documentation

The [fork documentation site](https://schero94.github.io/strapi-plugin-io/) summarizes setup, configuration, security, event behavior, and package ownership.

The source documentation in this checkout includes:

- [Getting started](./docs/guide/getting-started.md)
- [Plugin configuration](./docs/api/plugin-config.md)
- [Socket.IO class reference](./docs/api/io-class.md)
- [Content-type examples](./docs/examples/content-types.md)
- [Event examples](./docs/examples/events.md)
- [Migration guide](./docs/guide/migration.md)

These guides contain additional examples. Check each example against the current runtime before using it; older pages may describe behavior from earlier plugin versions.

## Features

- **Real-time events** for configured content-type create, update, and delete lifecycle actions.
- **Entity subscriptions** for joining entity rooms, subject to the configured role permissions.
- **JWT authentication** through the users-permissions plugin, with optional required-authentication policy.
- **Admin settings** for roles, event options, security, rooms, namespaces, Redis, and monitoring.
- **Room management** with role-based allowlists.
- **Namespaces** for separated Socket.IO channels.
- **Monitoring** for connections, rooms, event totals, and a bounded in-memory event log.
- **Redis adapter** support for multi-instance Socket.IO broadcasts.
- **Rate limiting** and IP allowlist or blocklist controls.
- **Input checks** for credentials, room names, entity identifiers, and test-event data.
- **TypeScript declarations** and server-side helper methods.
- **Admin dashboard widget** for connection and event statistics.

## Performance and scaling

The server's current defaults include a maximum of 1,000 concurrent connections per Strapi process, 20-second ping timeouts, 25-second ping intervals, a 45-second connection timeout, and a 1 MB maximum HTTP buffer. These are configuration defaults, not a load-test result or capacity guarantee.

Enable the Redis adapter when multiple Strapi instances need to share Socket.IO broadcasts. Redis does not remove the need to configure polling session affinity at the load balancer when polling transport is used. Test connection limits and resource use with the deployment's own workload.

## Migration from v2 (Strapi v4) to v3 (Strapi v5)

Version 2 targeted Strapi v4; this v3 line targets Strapi v5. Do not assume every configuration option or API is compatible across major versions. Review the [migration guide](./docs/guide/migration.md), compare its examples with this checkout, and test the application before upgrading.

For the upstream package, version selection is managed by the upstream repository. This fork is not installed by running <code>npm install strapi-plugin-io@latest</code>. For local work with this fork, follow the local installation steps above.

## Development

~~~sh
# Install the checked-in dependencies
npm ci

# Build the plugin
npm run build

# Watch for changes
npm run watch

# Verify plugin structure
npm run verify

# Run tests and lint
npm test
npm run lint
~~~

## Bugs

Report bugs in the [Schero94 fork issue tracker](https://github.com/Schero94/strapi-plugin-io/issues). For bugs in the public npm package, contact the [upstream project](https://github.com/ComfortablyCoding/strapi-plugin-io).

## Related plugins

Other Strapi v5 plugins by [@Schero94](https://github.com/Schero94):

### [Magic-Mail](https://github.com/Schero94/Magic-Mail)

Enterprise email management with OAuth 2.0.

### [Magic-Sessionmanager](https://github.com/Schero94/Magic-Sessionmanager)

Session tracking and administration.

### [Magicmark](https://github.com/Schero94/Magicmark)

Bookmark management.

## License

MIT

## Credits

The upstream project is maintained by [@ComfortablyCoding](https://github.com/ComfortablyCoding) and [@hrdunn](https://github.com/hrdunn).

The Schero94 fork is updated and enhanced by [@Schero94](https://github.com/Schero94).

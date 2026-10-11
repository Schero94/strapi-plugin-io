---
name: strapi-plugin-maintenance
description: Maintain the Strapi 5 Socket.IO plugin with room/event authorization, admin UI and conditional access tests.
---

# Strapi plugin IO maintenance

Use Node 22. Read local rules, retrieve current Strapi 5 plugin/route/design docs through Context7 and compare newest compatible 5.x with the workbench pin. Keep Socket.IO tokens, cookies and test data out of skills, Playwright artifacts and Git. Do not push without an explicit request.

Trace `server/src/routes/content-api.js`, `server/routes/admin.js`, handlers, socket handshake, room joins and event emission. Define anonymous, unprivileged admin, allowed admin, room member and non-member outcomes; enforce permissions on the server for every event and room, not just in the admin menu. Review CORS origins, token validation, input limits, rate limits and sanitization of monitoring output. Default smoke tests to local connections only.

Use Strapi 5 Design System for monitoring/settings with keyboard labels, empty/error/loading states and responsive layout; verify with Playwright CLI. Run `npm run build`, `npm run verify`, focused handshake/negative-access tests and shared app build/boot. `npm ci` currently fails against the upstream lockfile: workbench installer uses `npm install --package-lock=false`; fix the lockfile in a dedicated plugin branch before claiming reproducible CI.

'use strict';

/**
 * Admin HTTP API — mounted under /admin/* by src/index.js when ADMIN_PASSWORD is set.
 *
 * Auth model:
 *   POST /admin/login  { password }                    → { token, expires_at }
 *   All other endpoints require  Authorization: Bearer <token>
 *
 * Route management:
 *   GET    /admin/info
 *   GET    /admin/routes
 *   GET    /admin/routes/:id
 *   POST   /admin/routes                { route }
 *   PUT    /admin/routes/:id            { route partial }
 *   DELETE /admin/routes/:id
 *   POST   /admin/routes/:id/enable
 *   POST   /admin/routes/:id/disable
 *
 * All mutations atomically rewrite routes.json and call reloadRoutingConfig().
 * On validation failure the previous file is restored before returning an error.
 *
 * Sessions are in-memory only: restarting the bot invalidates all tokens
 * (the CLI will silently re-login using the saved password prompt).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createSettingsStore } = require('./settings');
const { createBackupStore } = require('./backups');

const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year — "maximally long" per user request
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 5;
const BODY_BYTE_LIMIT = 256 * 1024;

const sendJson = (res, status, obj) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  });
  res.end(JSON.stringify(obj));
};

const readJsonBody = async (req) => {
  let raw = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_BYTE_LIMIT) {
      throw Object.assign(new Error('Request body too large'), { status: 413 });
    }
    raw += chunk;
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
};

const timingSafeStringCompare = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

const getBearerToken = (req) => {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
};

/**
 * Replaces any inline `source.api_key` with a masked form
 * (first 4 + "***" + last 4 chars) for safe display in list/show responses.
 * Pass { reveal: true } to leave the field untouched.
 */
const maskRouteKey = (route, { reveal = false } = {}) => {
  if (reveal) return route;
  if (!route || route.source?.network !== 'api') return route;
  if (typeof route.source.api_key !== 'string' || !route.source.api_key) return route;
  const k = route.source.api_key;
  const masked = k.length <= 10
    ? '***'
    : `${k.slice(0, 4)}***${k.slice(-4)}`;
  return {
    ...route,
    source: { ...route.source, api_key: masked, api_key_masked: true },
  };
};

const parseQueryBool = (req) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const v = url.searchParams.get('reveal');
    return v === '1' || v === 'true' || v === 'yes';
  } catch {
    return false;
  }
};

const createAdminHandler = ({
  adminPassword,
  routingConfigPath,
  getRoutingConfig,
  reloadRoutingConfig,
  log,
}) => {
  const sessions = new Map();           // token → { issuedAt, expiresAt }
  const loginAttempts = new Map();       // ip → [timestamps]

  const settingsPath = path.join(path.dirname(routingConfigPath), 'settings.json');
  const settingsStore = createSettingsStore({ settingsPath, log });
  const backupStore = createBackupStore({ routingConfigPath, log });

  const purgeExpired = () => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expiresAt < now) sessions.delete(token);
    }
  };

  const rateLimitLogin = (ip) => {
    const now = Date.now();
    const recent = (loginAttempts.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    recent.push(now);
    loginAttempts.set(ip, recent);
    return recent.length <= LOGIN_MAX_ATTEMPTS;
  };

  const requireSession = (req) => {
    purgeExpired();
    const token = getBearerToken(req);
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    return { token, ...session };
  };

  const readRoutesFromDisk = () => {
    if (!fs.existsSync(routingConfigPath)) return [];
    const raw = fs.readFileSync(routingConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.routes) ? parsed.routes : [];
  };

  const atomicWriteRoutes = (routes) => {
    const payload = { routes };
    const dir = path.dirname(routingConfigPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${routingConfigPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, routingConfigPath);
  };

  /**
   * Writes a new routes array to disk and triggers an in-memory reload.
   * If reload fails validation, the previous file is restored and the
   * error is rethrown so the HTTP handler can return 400.
   *
   * When settings.backups.mode === "auto", a timestamped snapshot of the
   * pre-change routes.json is created first and pruned to settings.keep.
   * If the subsequent write/reload fails, that just-created backup is
   * removed to avoid duplicate rollback records.
   *
   * @param {Array}  nextRoutes  new routes[] to persist
   * @param {string} reason      short slug stamped into the backup name
   */
  const writeAndReload = (nextRoutes, reason = 'change') => {
    const previousFile = readRoutesFromDisk();
    const settings = settingsStore.get();

    let createdBackup = null;
    if (settings.backups.mode === 'auto' && fs.existsSync(routingConfigPath)) {
      try {
        createdBackup = backupStore.create(reason);
        backupStore.prune(settings.backups.keep);
      } catch (err) {
        log('backup: auto-snapshot failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    atomicWriteRoutes(nextRoutes);
    try {
      reloadRoutingConfig();
    } catch (err) {
      atomicWriteRoutes(previousFile);
      try { reloadRoutingConfig(); } catch { /* previous was valid */ }
      if (createdBackup) {
        try { backupStore.remove(createdBackup.name); } catch { /* ignore */ }
      }
      throw err;
    }
  };

  const sanitizeRoutePayload = (payload) => {
    // Drop unknown top-level keys so we don't leak stray fields into routes.json.
    const allowed = ['id', 'enabled', 'source', 'destinations', 'options'];
    const out = {};
    for (const key of allowed) {
      if (payload[key] !== undefined) out[key] = payload[key];
    }
    return out;
  };

  const handle = async (req, res, pathname) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      });
      res.end();
      return;
    }

    // ── Public: login ────────────────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/admin/login') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (!rateLimitLogin(ip)) {
        log('Admin login rate-limited', { ip });
        return sendJson(res, 429, { error: 'Too many login attempts, try again in 1 minute' });
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message });
      }
      const password = typeof body.password === 'string' ? body.password : '';
      if (!timingSafeStringCompare(password, adminPassword)) {
        log('Admin login failed', { ip });
        return sendJson(res, 401, { error: 'Invalid password' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      const issuedAt = Date.now();
      const expiresAt = issuedAt + SESSION_TTL_MS;
      sessions.set(token, { issuedAt, expiresAt });
      log('Admin login OK', { ip });
      return sendJson(res, 200, { token, expires_at: expiresAt, ttl_ms: SESSION_TTL_MS });
    }

    // ── All other endpoints require an active session ───────────────────
    const session = requireSession(req);
    if (!session) {
      return sendJson(res, 401, { error: 'Missing or invalid session token' });
    }

    if (req.method === 'POST' && pathname === '/admin/logout') {
      sessions.delete(session.token);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/admin/info') {
      const { routes } = getRoutingConfig();
      return sendJson(res, 200, {
        routes_total: routes.length,
        routes_enabled: routes.filter((r) => r.enabled !== false).length,
        session_expires_at: session.expiresAt,
        routing_config_path: routingConfigPath,
      });
    }

    if (req.method === 'GET' && pathname === '/admin/routes') {
      const { routes } = getRoutingConfig();
      const reveal = parseQueryBool(req);
      return sendJson(res, 200, { routes: routes.map((r) => maskRouteKey(r, { reveal })) });
    }

    if (req.method === 'POST' && pathname === '/admin/routes') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message });
      }
      const payload = sanitizeRoutePayload(body);
      if (!payload.id || typeof payload.id !== 'string') {
        return sendJson(res, 400, { error: 'id is required and must be a string' });
      }
      const current = readRoutesFromDisk();
      if (current.find((r) => r.id === payload.id)) {
        return sendJson(res, 409, { error: `route id "${payload.id}" already exists` });
      }
      try {
        writeAndReload([...current, payload], `add_${payload.id}`);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      log('Admin: route added', { route_id: payload.id });
      return sendJson(res, 201, { ok: true, route: payload });
    }

    // /admin/routes/:id (+ optional /enable | /disable)
    const routeMatch = pathname.match(/^\/admin\/routes\/([^/]+)(\/enable|\/disable)?$/);
    if (routeMatch) {
      const routeId = decodeURIComponent(routeMatch[1]);
      const action = routeMatch[2] || '';
      const current = readRoutesFromDisk();
      const index = current.findIndex((r) => r.id === routeId);
      if (index < 0) return sendJson(res, 404, { error: `route "${routeId}" not found` });

      if (!action && req.method === 'GET') {
        const reveal = parseQueryBool(req);
        return sendJson(res, 200, { route: maskRouteKey(current[index], { reveal }) });
      }

      if (!action && req.method === 'PUT') {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, err.status || 400, { error: err.message });
        }
        const patch = sanitizeRoutePayload(body);
        const updated = { ...current[index], ...patch, id: routeId };
        const next = current.slice();
        next[index] = updated;
        try {
          writeAndReload(next, `edit_${routeId}`);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
        log('Admin: route updated', { route_id: routeId });
        return sendJson(res, 200, { ok: true, route: updated });
      }

      if (!action && req.method === 'DELETE') {
        const next = current.filter((_, i) => i !== index);
        try {
          writeAndReload(next, `delete_${routeId}`);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
        log('Admin: route removed', { route_id: routeId });
        return sendJson(res, 200, { ok: true });
      }

      if ((action === '/enable' || action === '/disable') && req.method === 'POST') {
        const enabled = action === '/enable';
        const next = current.slice();
        next[index] = { ...current[index], enabled };
        try {
          writeAndReload(next, `${enabled ? 'enable' : 'disable'}_${routeId}`);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
        log(`Admin: route ${enabled ? 'enabled' : 'disabled'}`, { route_id: routeId });
        return sendJson(res, 200, { ok: true, route: next[index] });
      }
    }

    // ── Settings ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/admin/settings') {
      return sendJson(res, 200, { settings: settingsStore.get() });
    }

    if (req.method === 'PUT' && pathname === '/admin/settings') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message });
      }
      try {
        const updated = settingsStore.update(body);
        log('Admin: settings updated', { settings: updated });
        return sendJson(res, 200, { settings: updated });
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message });
      }
    }

    // ── Backups ──────────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/admin/backups') {
      return sendJson(res, 200, { backups: backupStore.list() });
    }

    if (req.method === 'POST' && pathname === '/admin/backups') {
      let body = {};
      try { body = await readJsonBody(req); }
      catch (err) { return sendJson(res, err.status || 400, { error: err.message }); }
      try {
        const created = backupStore.create(body.reason || 'manual');
        backupStore.prune(settingsStore.get().backups.keep);
        log('Admin: backup created', { name: created.name });
        return sendJson(res, 201, { backup: created });
      } catch (err) {
        return sendJson(res, err.status || 500, { error: err.message });
      }
    }

    // /admin/backups/:name(/restore)?
    const backupMatch = pathname.match(/^\/admin\/backups\/([^/]+)(\/restore)?$/);
    if (backupMatch) {
      const rawName = decodeURIComponent(backupMatch[1]);
      const isRestore = backupMatch[2] === '/restore';

      if (isRestore && req.method === 'POST') {
        let parsed;
        try { parsed = backupStore.read(rawName); }
        catch (err) { return sendJson(res, err.status || 500, { error: err.message }); }
        try {
          writeAndReload(parsed.routes, `restore_${rawName}`);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
        log('Admin: backup restored', { name: rawName });
        return sendJson(res, 200, { ok: true, routes_total: parsed.routes.length });
      }

      if (!isRestore && req.method === 'DELETE') {
        try {
          backupStore.remove(rawName);
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          return sendJson(res, err.status || 500, { error: err.message });
        }
      }
    }

    return sendJson(res, 404, { error: 'Not found' });
  };

  return { handle };
};

module.exports = { createAdminHandler };

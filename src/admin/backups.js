'use strict';

/**
 * Backups of routes.json, kept in config/backups/ next to the live file.
 *
 * File naming:
 *   routes-YYYYMMDD-HHMMSS-<reason>.json
 *
 *   - YYYYMMDD-HHMMSS is UTC so remote and local clocks sort consistently.
 *   - <reason> is a short slug supplied by the caller, sanitized to
 *     [a-z0-9_-], truncated to 40 chars. Purely informational.
 *
 * Retention:
 *   prune(keep) deletes the oldest files so only <keep> remain,
 *   honouring the current settings.backups.keep value.
 */

const fs = require('node:fs');
const path = require('node:path');

const FILE_PREFIX = 'routes-';
const FILE_SUFFIX = '.json';
const REASON_MAX = 40;

const pad = (n) => String(n).padStart(2, '0');

const formatStamp = (date = new Date()) => {
  const y = date.getUTCFullYear();
  const m = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `${y}${m}${d}-${hh}${mm}${ss}`;
};

const sanitizeReason = (reason) => {
  const str = String(reason || 'manual').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, REASON_MAX);
  return str || 'manual';
};

const parseBackupName = (name) => {
  // routes-20260411-174530-route_added_foo.json
  const match = name.match(/^routes-(\d{8})-(\d{6})-(.+)\.json$/);
  if (!match) return null;
  const [, ymd, hms, reason] = match;
  const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}Z`;
  const created = new Date(iso);
  return {
    name,
    reason,
    created_at: Number.isNaN(created.getTime()) ? null : created.toISOString(),
  };
};

const createBackupStore = ({ routingConfigPath, log = () => {} }) => {
  const backupsDir = path.join(path.dirname(routingConfigPath), 'backups');

  const ensureDir = () => {
    fs.mkdirSync(backupsDir, { recursive: true });
  };

  const list = () => {
    if (!fs.existsSync(backupsDir)) return [];
    const entries = fs.readdirSync(backupsDir)
      .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX));

    const results = [];
    for (const name of entries) {
      const meta = parseBackupName(name);
      if (!meta) continue;
      try {
        const stat = fs.statSync(path.join(backupsDir, name));
        results.push({ ...meta, size: stat.size });
      } catch { /* ignore */ }
    }
    results.sort((a, b) => b.name.localeCompare(a.name)); // newest first
    return results;
  };

  /**
   * Creates a snapshot of the current routes.json.
   * Returns { name, path, created_at, size, reason }.
   * Throws if routes.json doesn't exist.
   */
  const create = (reason) => {
    if (!fs.existsSync(routingConfigPath)) {
      throw Object.assign(new Error('routes.json does not exist; nothing to back up'), { status: 404 });
    }
    ensureDir();
    const stamp = formatStamp();
    const slug = sanitizeReason(reason);
    const name = `${FILE_PREFIX}${stamp}-${slug}${FILE_SUFFIX}`;
    const fullPath = path.join(backupsDir, name);

    // If we somehow land on the exact same second twice, suffix a counter.
    let finalName = name;
    let finalPath = fullPath;
    let counter = 2;
    while (fs.existsSync(finalPath)) {
      finalName = `${FILE_PREFIX}${stamp}-${slug}-${counter}${FILE_SUFFIX}`;
      finalPath = path.join(backupsDir, finalName);
      counter += 1;
    }

    fs.copyFileSync(routingConfigPath, finalPath);
    const stat = fs.statSync(finalPath);
    log('backup: created', { name: finalName, reason: slug, size: stat.size });
    return {
      name: finalName,
      path: finalPath,
      created_at: new Date().toISOString(),
      size: stat.size,
      reason: slug,
    };
  };

  /**
   * Reads a backup file and returns its parsed content
   * ({ routes: [...] }). Throws if not found or invalid JSON.
   */
  const read = (name) => {
    const safe = path.basename(name); // prevent path traversal
    const fullPath = path.join(backupsDir, safe);
    if (!fs.existsSync(fullPath)) {
      throw Object.assign(new Error(`backup "${safe}" not found`), { status: 404 });
    }
    const raw = fs.readFileSync(fullPath, 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (err) {
      throw Object.assign(new Error(`backup "${safe}" is not valid JSON: ${err.message}`), { status: 500 });
    }
    if (!parsed || !Array.isArray(parsed.routes)) {
      throw Object.assign(new Error(`backup "${safe}" has no routes[] array`), { status: 500 });
    }
    return parsed;
  };

  const remove = (name) => {
    const safe = path.basename(name);
    const fullPath = path.join(backupsDir, safe);
    if (!fs.existsSync(fullPath)) {
      throw Object.assign(new Error(`backup "${safe}" not found`), { status: 404 });
    }
    fs.unlinkSync(fullPath);
    log('backup: removed', { name: safe });
    return { ok: true };
  };

  /**
   * Deletes the oldest files so at most `keep` remain.
   * Returns the list of removed filenames.
   */
  const prune = (keep) => {
    const all = list(); // sorted newest-first
    if (all.length <= keep) return [];
    const toRemove = all.slice(keep);
    const removed = [];
    for (const item of toRemove) {
      try {
        fs.unlinkSync(path.join(backupsDir, item.name));
        removed.push(item.name);
      } catch (err) {
        log('backup: prune failed', { name: item.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (removed.length) log('backup: pruned', { removed: removed.length, kept: keep });
    return removed;
  };

  return {
    backupsDir,
    list,
    create,
    read,
    remove,
    prune,
  };
};

module.exports = {
  createBackupStore,
  sanitizeReason,
  parseBackupName,
};

'use strict';

/**
 * Runtime settings for the bridge admin layer.
 *
 * Stored at config/settings.json next to routes.json. Env vars
 * BACKUPS_KEEP and BACKUPS_MODE act as defaults when the file is
 * missing or a field is not set; they can also be used to hard-pin
 * values — the CLI's PUT /admin/settings will still succeed, but the
 * env var takes precedence on every reload.
 *
 * Shape:
 *   {
 *     backups: {
 *       keep: <int 1..1000>,     // how many snapshots to retain
 *       mode: "auto" | "manual"  // auto = snapshot before every mutation
 *     }
 *   }
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  backups: {
    keep: 20,
    mode: 'auto',
  },
});

const MIN_KEEP = 1;
const MAX_KEEP = 1000;
const VALID_MODES = new Set(['auto', 'manual']);

const clampKeep = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULTS.backups.keep;
  const rounded = Math.round(num);
  if (rounded < MIN_KEEP) return MIN_KEEP;
  if (rounded > MAX_KEEP) return MAX_KEEP;
  return rounded;
};

const normalizeMode = (value) => {
  const str = String(value || '').trim().toLowerCase();
  return VALID_MODES.has(str) ? str : DEFAULTS.backups.mode;
};

const fromEnv = () => {
  const out = {};
  if (process.env.BACKUPS_KEEP) out.keep = clampKeep(process.env.BACKUPS_KEEP);
  if (process.env.BACKUPS_MODE) out.mode = normalizeMode(process.env.BACKUPS_MODE);
  return out;
};

const createSettingsStore = ({ settingsPath, log = () => {} }) => {
  const readFromDisk = () => {
    if (!fs.existsSync(settingsPath)) return {};
    try {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      log('settings: failed to parse, falling back to defaults', {
        path: settingsPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  };

  const resolve = () => {
    const fileData = readFromDisk();
    const envData = fromEnv();
    return {
      backups: {
        keep: envData.keep ?? clampKeep(fileData.backups?.keep ?? DEFAULTS.backups.keep),
        mode: envData.mode ?? normalizeMode(fileData.backups?.mode ?? DEFAULTS.backups.mode),
      },
    };
  };

  const atomicWrite = (data) => {
    const dir = path.dirname(settingsPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, settingsPath);
  };

  /**
   * Applies a partial patch and returns the new effective settings
   * (after env overrides). Throws on validation errors.
   */
  const update = (patch) => {
    if (!patch || typeof patch !== 'object') {
      throw Object.assign(new Error('settings patch must be an object'), { status: 400 });
    }

    const fileData = readFromDisk();
    const next = {
      backups: { ...DEFAULTS.backups, ...(fileData.backups || {}) },
    };

    if (patch.backups && typeof patch.backups === 'object') {
      if (patch.backups.keep !== undefined) {
        const keep = Number(patch.backups.keep);
        if (!Number.isFinite(keep) || keep < MIN_KEEP || keep > MAX_KEEP) {
          throw Object.assign(new Error(`backups.keep must be an integer in [${MIN_KEEP}, ${MAX_KEEP}]`), { status: 400 });
        }
        next.backups.keep = Math.round(keep);
      }
      if (patch.backups.mode !== undefined) {
        const mode = String(patch.backups.mode).trim().toLowerCase();
        if (!VALID_MODES.has(mode)) {
          throw Object.assign(new Error(`backups.mode must be "auto" or "manual"`), { status: 400 });
        }
        next.backups.mode = mode;
      }
    }

    atomicWrite(next);
    log('settings: updated', { settings: next });
    return resolve();
  };

  return {
    get: resolve,
    update,
    defaults: () => ({ ...DEFAULTS }),
    settingsPath,
  };
};

module.exports = {
  DEFAULTS,
  MIN_KEEP,
  MAX_KEEP,
  VALID_MODES,
  createSettingsStore,
};

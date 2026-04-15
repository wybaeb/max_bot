'use strict';

/**
 * Interactive arrow-key menu — invoked either as `max-bot-bridge tui`
 * or as the default action when the CLI is run with no arguments.
 *
 * The menu loops until the user picks "Quit" (or presses Ctrl+C).
 */

const commands = require('./commands');
const client = require('./client');
const session = require('./session');
const ui = require('./ui');

const loadInquirer = () => require('@inquirer/prompts');

const HEADER = [
  '',
  ui.colors.bold(ui.colors.cyan('╭────────────────────────────────────────╮')),
  ui.colors.bold(ui.colors.cyan('│      max-bot-bridge — bridge CLI       │')),
  ui.colors.bold(ui.colors.cyan('╰────────────────────────────────────────╯')),
  '',
].join('\n');

const printHeader = () => console.log(HEADER);

const ensureSession = async () => {
  const existing = session.loadSession();
  if (existing && existing.expires_at && existing.expires_at > Date.now()) return existing;

  ui.info('No active session found — please log in.');
  await commands.cmdLogin();
  return session.requireSession();
};

const pickRoute = async (routes, promptMessage = 'Pick a route:') => {
  if (!routes.length) {
    ui.info('(no routes configured yet)');
    return null;
  }
  const inquirer = loadInquirer();
  const picked = await inquirer.select({
    message: promptMessage,
    pageSize: Math.min(20, Math.max(5, routes.length)),
    choices: [
      ...routes.map((r) => ({
        name: `${r.enabled === false ? ui.symbols.disabled : ui.symbols.enabled}  ${r.id}    ${ui.colors.dim(ui.formatEndpoint(r.source) + ' → ' + (r.destinations || []).map(ui.formatEndpoint).join(', '))}`,
        value: r.id,
      })),
      { name: ui.colors.dim('← Back'), value: '__back__' },
    ],
  });
  if (picked === '__back__') return null;
  return picked;
};

const manageRoute = async (sess, routeId) => {
  const inquirer = loadInquirer();
  while (true) {
    const route = await client.getRoute(sess, routeId);
    console.log('');
    console.log(ui.renderRouteFull(route));
    console.log('');

    const action = await inquirer.select({
      message: `What do you want to do with "${route.id}"?`,
      choices: [
        { name: route.enabled === false ? '● Enable' : '○ Disable', value: 'toggle' },
        { name: '✎ Edit source', value: 'source' },
        { name: '✎ Edit destinations', value: 'destinations' },
        { name: '✎ Edit options', value: 'options' },
        { name: '↻ Full re-wizard', value: 'full' },
        { name: '✖ Delete route', value: 'delete' },
        { name: ui.colors.dim('← Back'), value: 'back' },
      ],
    });

    try {
      if (action === 'back') return;

      if (action === 'toggle') {
        if (route.enabled === false) {
          await client.enableRoute(sess, route.id);
          ui.success(`Enabled "${route.id}"`);
        } else {
          await client.disableRoute(sess, route.id);
          ui.success(`Disabled "${route.id}"`);
        }
        continue;
      }

      if (action === 'source') {
        const source = await commands.wizardCollectSource(route.source);
        await client.updateRoute(sess, route.id, { source });
        ui.success('Source updated.');
        continue;
      }

      if (action === 'destinations') {
        const destinations = await commands.wizardCollectDestinations(route.destinations);
        await client.updateRoute(sess, route.id, { destinations });
        ui.success('Destinations updated.');
        continue;
      }

      if (action === 'options') {
        const options = await commands.wizardCollectOptions(route.options || {});
        await client.updateRoute(sess, route.id, { options });
        ui.success('Options updated.');
        continue;
      }

      if (action === 'full') {
        const full = await commands.wizardCollectRoute({ prefill: route });
        await client.updateRoute(sess, route.id, { ...full, id: route.id });
        ui.success('Route re-saved from wizard.');
        continue;
      }

      if (action === 'delete') {
        const ok = await inquirer.confirm({ message: `Really delete "${route.id}"?`, default: false });
        if (!ok) { ui.info('Aborted.'); continue; }
        await client.deleteRoute(sess, route.id);
        ui.success(`Deleted "${route.id}"`);
        return;
      }
    } catch (err) {
      ui.error(err.message || String(err));
      // loop continues — let the user try again
    }
  }
};

const backupsMenu = async (sess) => {
  const inquirer = loadInquirer();
  while (true) {
    let backups = [];
    try { backups = await client.listBackups(sess); }
    catch (err) { ui.error(err.message || String(err)); return; }

    console.log('');
    ui.title(`Backups (${backups.length})`);
    if (!backups.length) {
      console.log(ui.colors.dim('(no backups yet)'));
    } else {
      for (const b of backups.slice(0, 10)) {
        const when = b.created_at ? new Date(b.created_at).toISOString().replace('T', ' ').slice(0, 19) : '?';
        console.log(`  ${ui.colors.bold(b.name)}`);
        console.log(`    ${ui.colors.dim(`${when}  ${b.size} B  reason: ${b.reason}`)}`);
      }
      if (backups.length > 10) console.log(ui.colors.dim(`  … +${backups.length - 10} more`));
    }
    console.log('');

    const action = await inquirer.select({
      message: 'Backups menu',
      choices: [
        { name: '➕  Create snapshot now', value: 'create' },
        { name: '↩   Restore from a snapshot', value: 'restore', disabled: !backups.length },
        { name: '✖   Delete a snapshot', value: 'delete', disabled: !backups.length },
        { name: ui.colors.dim('← Back'), value: 'back' },
      ],
    });

    try {
      if (action === 'back') return;

      if (action === 'create') {
        const reason = await inquirer.input({ message: 'Reason (short slug):', default: 'manual' });
        const created = await client.createBackup(sess, reason);
        ui.success(`Created ${created.name}`);
        continue;
      }

      if (action === 'restore' || action === 'delete') {
        const name = await inquirer.select({
          message: action === 'restore' ? 'Restore from which snapshot?' : 'Delete which snapshot?',
          pageSize: Math.min(20, Math.max(5, backups.length)),
          choices: [
            ...backups.map((b) => ({
              name: `${b.name}  ${ui.colors.dim(`(${b.reason}, ${b.size} B)`)}`,
              value: b.name,
            })),
            { name: ui.colors.dim('← Back'), value: '__back__' },
          ],
        });
        if (name === '__back__') continue;

        const ok = await inquirer.confirm({
          message: action === 'restore'
            ? `Restore routes.json from "${name}"? Current state will be overwritten.`
            : `Delete backup "${name}"?`,
          default: false,
        });
        if (!ok) { ui.info('Aborted.'); continue; }

        if (action === 'restore') {
          const res = await client.restoreBackup(sess, name);
          ui.success(`Restored from "${name}" (${res.routes_total} routes now live)`);
        } else {
          await client.deleteBackup(sess, name);
          ui.success(`Deleted "${name}"`);
        }
      }
    } catch (err) {
      ui.error(err.message || String(err));
    }
  }
};

const settingsMenu = async (sess) => {
  const inquirer = loadInquirer();
  while (true) {
    let settings;
    try { settings = await client.getSettings(sess); }
    catch (err) { ui.error(err.message || String(err)); return; }

    console.log('');
    ui.title('Settings');
    console.log(`  ${ui.colors.bold('backups.keep:')}  ${settings.backups.keep}`);
    console.log(`  ${ui.colors.bold('backups.mode:')}  ${settings.backups.mode}    ${ui.colors.dim('(auto = snapshot before every change)')}`);
    console.log('');

    const action = await inquirer.select({
      message: 'Settings menu',
      choices: [
        { name: `Change backups.keep (current: ${settings.backups.keep})`, value: 'keep' },
        { name: `Change backups.mode (current: ${settings.backups.mode})`, value: 'mode' },
        { name: ui.colors.dim('← Back'), value: 'back' },
      ],
    });

    try {
      if (action === 'back') return;

      if (action === 'keep') {
        const raw = await inquirer.input({
          message: 'backups.keep (1..1000):',
          default: String(settings.backups.keep),
          validate: (v) => {
            const n = Number(v);
            return Number.isFinite(n) && n >= 1 && n <= 1000 ? true : 'Integer 1..1000';
          },
        });
        await client.updateSettings(sess, { backups: { keep: Number(raw) } });
        ui.success(`backups.keep = ${raw}`);
        continue;
      }

      if (action === 'mode') {
        const mode = await inquirer.select({
          message: 'backups.mode:',
          default: settings.backups.mode,
          choices: [
            { name: 'auto  — snapshot before every mutation', value: 'auto' },
            { name: 'manual — only via `backup create` / TUI', value: 'manual' },
          ],
        });
        await client.updateSettings(sess, { backups: { mode } });
        ui.success(`backups.mode = ${mode}`);
      }
    } catch (err) {
      ui.error(err.message || String(err));
    }
  }
};

const mainMenu = async () => {
  printHeader();
  const sess = await ensureSession();

  const inquirer = loadInquirer();

  while (true) {
    // Refresh summary from server
    let summary = null;
    try {
      summary = await client.info(sess);
    } catch (err) {
      if (err instanceof client.ApiError && (err.status === 401 || err.status === 403)) {
        ui.warn('Session rejected by server. Re-logging in.');
        session.clearSession();
        await commands.cmdLogin(sess.host, { port: sess.port });
        continue;
      }
      ui.error(err.message || String(err));
    }

    if (summary) {
      console.log('');
      console.log(`${ui.colors.dim('server:')} ${sess.scheme || 'http'}://${sess.host}:${sess.port || 3000}`);
      console.log(`${ui.colors.dim('routes:')} ${summary.routes_enabled} enabled / ${summary.routes_total} total`);
      console.log('');
    }

    const choice = await inquirer.select({
      message: 'Main menu',
      choices: [
        { name: '📋  List all routes', value: 'list' },
        { name: '🔧  Manage a route (edit / enable / disable / delete)', value: 'manage' },
        { name: '➕  Add a new route', value: 'add' },
        { name: '🛡   Backups (list / create / restore / delete)', value: 'backups' },
        { name: '⚙   Settings (retention, auto/manual mode)', value: 'settings' },
        { name: '👤  Who am I / session info', value: 'whoami' },
        { name: '🚪  Logout', value: 'logout' },
        { name: '❌  Quit', value: 'quit' },
      ],
    });

    try {
      if (choice === 'quit') { ui.info('Bye.'); return; }

      if (choice === 'list') {
        const routes = await client.listRoutes(sess);
        ui.title(`Routes (${routes.length})`);
        console.log(ui.renderRoutesList(routes));
        console.log('');
        await inquirer.input({ message: ui.colors.dim('(press Enter to continue)'), default: '' });
        continue;
      }

      if (choice === 'manage') {
        const routes = await client.listRoutes(sess);
        const routeId = await pickRoute(routes, 'Which route do you want to manage?');
        if (routeId) await manageRoute(sess, routeId);
        continue;
      }

      if (choice === 'add') {
        const route = await commands.wizardCollectRoute();
        console.log('\n' + ui.colors.dim('Creating route:'));
        console.log(ui.renderRouteFull(route));
        const ok = await inquirer.confirm({ message: 'Create this route?', default: true });
        if (!ok) { ui.info('Aborted.'); continue; }
        await client.createRoute(sess, route);
        ui.success(`Created route "${route.id}"`);
        continue;
      }

      if (choice === 'backups') {
        await backupsMenu(sess);
        continue;
      }

      if (choice === 'settings') {
        await settingsMenu(sess);
        continue;
      }

      if (choice === 'whoami') {
        await commands.cmdWhoami();
        console.log('');
        await inquirer.input({ message: ui.colors.dim('(press Enter to continue)'), default: '' });
        continue;
      }

      if (choice === 'logout') {
        await commands.cmdLogout();
        return;
      }
    } catch (err) {
      if (err && err.name === 'ExitPromptError') return; // Ctrl+C from prompt
      ui.error(err.message || String(err));
    }
  }
};

module.exports = { mainMenu };

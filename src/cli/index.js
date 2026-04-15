'use strict';

/**
 * Bridge CLI entry.
 *
 * Two usage modes:
 *   1. Subcommand: `max-bot-bridge <command> [...]`
 *   2. Interactive TUI: `max-bot-bridge` (no arguments) — arrow-key menu.
 *
 * The `-h / --help` flag is extra-verbose so both humans and LLM agents can
 * understand every command without reading the README.
 */

const { Command, Option } = require('commander');

const commands = require('./commands');
const tui = require('./tui');

const VERSION = require('../../package.json').version || '1.0.0';

const AGENT_NOTE = `
Agent-friendly usage
--------------------
  - Every non-interactive flag is also available as an env var with the
    MAX_BOT_BRIDGE_ prefix (e.g. --password → MAX_BOT_BRIDGE_PASSWORD).
  - Pass --json to list / show to get machine-readable output.
  - Exit codes:
      0  success
      1  generic error (network, validation, server)
      2  auth error (not logged in / wrong password / expired session)
      3  resource not found (unknown route id)
  - To script a fresh install:
      max-bot-bridge login <host> --password=$PW
      max-bot-bridge add --json-file=./route.json       # (not in v1 yet)
      max-bot-bridge list --json | jq '.[].id'
  - Interactive prompts (add/edit) require a TTY and @inquirer/prompts.
    For unattended scripts use explicit flags when available.
`.trim();

const LONG_DESCRIPTION = `
max-bot-bridge — control panel for the Telegram/API → MAX bridge bot.

Authenticates against the bot's admin HTTP endpoint (enabled when
ADMIN_PASSWORD is set in the bot's .env) and lets you list, add, edit,
remove, enable or disable bridging routes without touching routes.json
by hand or redeploying.

Quick start:
  1) On the bot server:  add ADMIN_PASSWORD=<secret> to .env and restart.
  2) On your machine:    max-bot-bridge login <ip>
  3) Enjoy:              max-bot-bridge          (opens interactive TUI)

Security:
  The admin API speaks plain HTTP over the port set by API_PORT (default
  3000). Before exposing it to the internet, put it behind TLS (Caddy,
  Nginx) or tunnel it over SSH:
      ssh -L 3000:localhost:3000 root@your-bot
      max-bot-bridge login localhost
`.trim();

const run = async (argv) => {
  const program = new Command();

  program
    .name('max-bot-bridge')
    .version(VERSION, '-v, --version', 'print CLI version')
    .description(LONG_DESCRIPTION)
    .addHelpText('after', `\n${AGENT_NOTE}\n`);

  // ── login ────────────────────────────────────────────────────────────
  program
    .command('login [host]')
    .description('Authenticate against a running bot and save a long-lived session')
    .addOption(new Option('-p, --port <port>', 'admin API port').default('3000'))
    .addOption(new Option('-s, --scheme <scheme>', 'http or https').default('http').choices(['http', 'https']))
    .addOption(new Option('--password <password>', 'admin password (prefer stdin/env for security)').env('MAX_BOT_BRIDGE_PASSWORD'))
    .addHelpText('after', `
Examples:
  $ max-bot-bridge login your-server-ip
  $ max-bot-bridge login example.com --port 8080 --scheme https
  $ MAX_BOT_BRIDGE_PASSWORD=secret max-bot-bridge login 10.0.0.5 --password $MAX_BOT_BRIDGE_PASSWORD
`)
    .action((host, opts) => commands.cmdLogin(host, opts));

  program
    .command('logout')
    .description('Revoke the current server session and wipe it from disk')
    .action(() => commands.cmdLogout());

  program
    .command('whoami')
    .description('Show the active session and server summary')
    .action(() => commands.cmdWhoami());

  // ── list / ls ─────────────────────────────────────────────────────────
  program
    .command('list')
    .alias('ls')
    .description('List all bridging routes with source → destinations')
    .option('--json', 'print the raw JSON array from /admin/routes')
    .option('--reveal', 'unmask inline api_key values (otherwise masked as abcd***wxyz)')
    .action((opts) => commands.cmdList(opts));

  // ── show ──────────────────────────────────────────────────────────────
  program
    .command('show <id>')
    .description('Show one route in detail (source, destinations, options, raw JSON)')
    .option('--json', 'print raw JSON only')
    .option('--reveal', 'unmask inline api_key values (otherwise masked as abcd***wxyz)')
    .action((id, opts) => commands.cmdShow(id, opts));

  // ── enable / disable ─────────────────────────────────────────────────
  program
    .command('enable <id>')
    .description('Enable a route (bridge will start processing it on next message)')
    .action((id) => commands.cmdEnable(id));

  program
    .command('disable <id>')
    .description('Disable a route (keeps the config entry but stops processing)')
    .action((id) => commands.cmdDisable(id));

  // ── add ──────────────────────────────────────────────────────────────
  program
    .command('add')
    .description('Add a new route via an interactive wizard (id, source, destinations, options)')
    .addHelpText('after', `
This command requires a TTY. For non-interactive api→X setup use
\`max-bot-bridge add-api\` (see below).
`)
    .action(() => commands.cmdAdd());

  // ── add-api (non-interactive, scriptable) ─────────────────────────────
  program
    .command('add-api <id>')
    .description('Create an api-source route in one command (auto-generates a key by default)')
    .option('--generate-key', 'auto-generate a random 32-byte base64url key (default when neither --key nor --env-var given)')
    .option('--key <value>', 'use this exact key (>= 16 chars) stored inline in routes.json')
    .option('--env-var <NAME>', 'reference an env var name instead of inlining the key (UPPER_SNAKE_CASE)')
    .option('--telegram <chat_id...>', 'destination Telegram chat_id (can be repeated)')
    .option('--max <chat_id...>', 'destination MAX chat_id (can be repeated)')
    .option('--max-user <user_id...>', 'destination MAX user_id (DM; can be repeated)')
    .option('--delay <ms>', 'per-route repost_delay_ms override', parseInt)
    .option('--disabled', 'create the route in disabled state')
    .addHelpText('after', `
Examples:
  $ max-bot-bridge add-api form-leads --telegram -5075596986
      → generates a key, prints curl, ready for integration

  $ max-bot-bridge add-api alerts --max -70999607981465 --max -71276213876121
      → one route → two MAX destinations, key auto-generated

  $ max-bot-bridge add-api ci-bot --env-var API_KEY_CI --telegram -1001234567890
      → uses a key stored in the server's .env (API_KEY_CI must exist there)

  $ max-bot-bridge add-api import --key "my-preshared-at-least-16-chars" --telegram -1001234567890
      → pin a specific inline key (not recommended — prefer --generate-key)

After creation, the API key is printed ONCE. Re-reveal later with:
  $ max-bot-bridge show <id> --reveal
`)
    .action((id, opts) => commands.cmdAddApi(id, opts));

  // ── edit ─────────────────────────────────────────────────────────────
  program
    .command('edit <id>')
    .description('Edit an existing route: toggle enabled, change source/destinations/options')
    .action((id) => commands.cmdEdit(id));

  // ── remove ───────────────────────────────────────────────────────────
  program
    .command('remove <id>')
    .alias('rm')
    .description('Delete a route (prompts for confirmation unless --force)')
    .option('-f, --force', 'skip the confirmation prompt')
    .action((id, opts) => commands.cmdRemove(id, opts));

  // ── settings ─────────────────────────────────────────────────────────
  const settingsCmd = program
    .command('settings')
    .description('View or change runtime settings (backup retention count, backup mode)');

  settingsCmd
    .command('show')
    .description('Print the effective settings merged with env var overrides')
    .option('--json', 'print raw JSON')
    .action((opts) => commands.cmdSettingsShow(opts));

  settingsCmd
    .command('set <key> <value>')
    .description('Change a single setting (keys: backups.keep, backups.mode)')
    .addHelpText('after', `
Known settings:
  backups.keep  integer 1..1000   — how many snapshots to retain (default 20)
  backups.mode  auto | manual     — auto = snapshot before every mutation
                                    manual = only on 'backup create'

Examples:
  $ max-bot-bridge settings set backups.keep 50
  $ max-bot-bridge settings set backups.mode manual
`)
    .action((key, value) => commands.cmdSettingsSet(key, value));

  // ── backups ──────────────────────────────────────────────────────────
  const backupCmd = program
    .command('backup')
    .description('Manage snapshots of routes.json (list, create, restore, delete)');

  backupCmd
    .command('list')
    .alias('ls')
    .description('List all available snapshots, newest first')
    .option('--json', 'print raw JSON')
    .action((opts) => commands.cmdBackupList(opts));

  backupCmd
    .command('create')
    .description('Create a manual snapshot of routes.json right now')
    .option('--reason <reason>', 'short slug recorded in the filename (default "manual")')
    .action((opts) => commands.cmdBackupCreate(opts));

  backupCmd
    .command('restore <name>')
    .description('Restore routes.json from a named snapshot (hot-reload, no restart)')
    .option('-f, --force', 'skip the confirmation prompt')
    .action((name, opts) => commands.cmdBackupRestore(name, opts));

  backupCmd
    .command('delete <name>')
    .alias('rm')
    .description('Delete one snapshot file')
    .option('-f, --force', 'skip the confirmation prompt')
    .action((name, opts) => commands.cmdBackupDelete(name, opts));

  // ── tui ──────────────────────────────────────────────────────────────
  program
    .command('tui')
    .description('Open the interactive arrow-key menu (default when invoked without arguments)')
    .action(() => tui.mainMenu());

  // Hand argv to commander. If no subcommand was given, drop into the TUI.
  if (argv.length <= 2) {
    return tui.mainMenu();
  }

  await program.parseAsync(argv);
};

module.exports = { run };

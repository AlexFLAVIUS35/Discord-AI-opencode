#!/usr/bin/env node
process.removeAllListeners('warning');
import { Command } from 'commander';
import pc from 'picocolors';
import { createRequire } from 'module';
import updateNotifier from 'update-notifier';
import { runSetupWizard } from './setup/wizard.js';
import { deployCommands } from './setup/deploy.js';
import { undeployCommands } from './setup/undeploy.js';
import { startBot } from './bot.js';
import { hasBotConfig, getConfigDir, getAllowedUserIds, addAllowedUserId, removeAllowedUserId, setAllowedUserIds, getOpenAIApiKey, setOpenAIApiKey, removeOpenAIApiKey } from './services/configStore.js';

const require = createRequire(import.meta.url);
// In dev mode (src/cli.ts), package.json is one level up.
// In production (dist/src/cli.js), package.json is two levels up.
const pkg = (() => {
  try {
    return require('../package.json');
  } catch {
    return require('../../package.json');
  }
})();

updateNotifier({ pkg }).notify({ isGlobal: true });

const program = new Command();

program
  .name('remote-opencode')
  .description('Discord bot for remote OpenCode CLI access')
  .version(pkg.version);

program
  .command('start')
  .description('Start the Discord bot')
  .action(async () => {
    if (!hasBotConfig()) {
      console.log(pc.yellow('No bot configuration found.'));
      console.log(`Run ${pc.cyan('remote-opencode setup')} first to configure your Discord bot.\n`);
      process.exit(1);
    }
    
    try {
      await deployCommands();
    } catch {
      // Continue even if command deployment fails; the bot can still start.
    }

    await startBot();
  });

program
  .command('setup')
  .description('Configure the Discord bot')
  .action(async () => {
    await runSetupWizard();
  });

program
  .command('deploy')
  .description('Deploy Discord slash commands')
  .action(async () => {
    await deployCommands();
  });

program
  .command('undeploy')
  .description('Remove deployed Discord slash commands')
  .action(async () => {
    await undeployCommands();
  });

program
  .command('config')
  .description('Show configuration directory')
  .action(() => {
    console.log(getConfigDir());
  });

program
  .command('allow')
  .description('Manage allowed Discord users')
  .argument('[userId]', 'Discord user ID to allow')
  .action((userId?: string) => {
    if (userId) {
      addAllowedUserId(userId);
      console.log(pc.green(`Allowed user ${userId}`));
      return;
    }
    console.log(getAllowedUserIds().join('\n') || pc.dim('No users configured.'));
  });

program
  .command('disallow')
  .description('Remove a Discord user from the allowlist')
  .argument('<userId>', 'Discord user ID')
  .action((userId: string) => {
    removeAllowedUserId(userId);
    console.log(pc.green(`Removed user ${userId}`));
  });

program
  .command('allow-all')
  .description('Allow all Discord users')
  .action(() => {
    setAllowedUserIds([]);
    console.log(pc.green('Allowlist cleared. All users are allowed.'));
  });

program.parseAsync().catch((error) => {
  console.error(error);
  process.exit(1);
});

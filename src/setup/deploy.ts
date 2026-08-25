import { REST, Routes } from 'discord.js';
import { getBotConfig } from '../services/configStore.js';
import { commands } from '../commands/index.js';
import { initializeProxySupport } from '../services/proxySupport.js';
import pc from 'picocolors';

export async function deployCommands(): Promise<void> {
  const config = getBotConfig();

  if (!config) {
    throw new Error('Bot configuration not found. Run setup first.');
  }

  // Use the command metadata from commands/index.ts as-is. In particular,
  // activation commands must retain their DM + guild contexts for User Install
  // DMs and Guild Install servers respectively.
  const commandsData = Array.from(commands.values()).map(c => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  initializeProxySupport();

  console.log(pc.dim(`Removing legacy guild command registration from ${config.guildId}...`));
  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body: [] },
  );

  console.log(pc.dim(`Deploying ${commandsData.length} global slash commands...`));
  await rest.put(
    Routes.applicationCommands(config.clientId),
    { body: commandsData },
  );

  console.log(pc.green(`Successfully deployed ${commandsData.length} global slash commands.`));
  console.log(pc.dim('Guild installation uses the global command set; User Install uses the commands marked for user installation.'));
}

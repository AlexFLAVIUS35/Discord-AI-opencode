import { REST, Routes } from 'discord.js';
import { getBotConfig } from '../services/configStore.js';
import { commands } from '../commands/index.js';
import { initializeProxySupport } from '../services/proxySupport.js';
import pc from 'picocolors';

export async function deployCommands(): Promise<void> {
  const config = getBotConfig();
  if (!config) throw new Error('Bot configuration not found. Run setup first.');

  const commandsData = Array.from(commands.values()).map(c => c.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  initializeProxySupport();

  // Register commands globally only. Registering the same command set both
  // globally and in the guild makes Discord display duplicate command entries.
  console.log(pc.dim(`Removing legacy guild command registration from ${config.guildId}...`));
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: [] });

  console.log(pc.dim(`Deploying ${commandsData.length} global slash commands...`));
  await rest.put(Routes.applicationCommands(config.clientId), { body: commandsData });

  console.log(pc.green(`Successfully deployed ${commandsData.length} global slash commands.`));
}

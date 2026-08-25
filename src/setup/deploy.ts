import { REST, Routes, ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import { getBotConfig } from '../services/configStore.js';
import { commands } from '../commands/index.js';
import { initializeProxySupport } from '../services/proxySupport.js';
import pc from 'picocolors';

export async function deployCommands(): Promise<void> {
  const config = getBotConfig();

  if (!config) {
    throw new Error('Bot configuration not found. Run setup first.');
  }

  const commandsData = Array.from(commands.values()).map(c => {
    const data = c.data.toJSON() as any;

    // Keep activation controls strictly guild-install commands at the raw REST
    // payload level too. This prevents stale/incorrect integration metadata from
    // making /activate or /deactivate appear in User Install command menus.
    if (data.name === 'activate' || data.name === 'deactivate') {
      data.integration_types = [ApplicationIntegrationType.GuildInstall];
      data.contexts = [InteractionContextType.Guild];
    }

    return data;
  });
  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  initializeProxySupport();

  // Remove the old guild-scoped registration first. The project now has one
  // canonical global registration so Discord does not show duplicate commands.
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

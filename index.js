import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} from "discord.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error("Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID.");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check if the ASH bot is online."),

  new SlashCommandBuilder()
    .setName("ashmode")
    .setDescription("Set ASH gift-code mode.")
    .addStringOption(option =>
      option
        .setName("mode")
        .setDescription("approval or auto")
        .setRequired(true)
        .addChoices(
          { name: "Approval", value: "approval" },
          { name: "Auto", value: "auto" }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("usecode")
    .setDescription("Submit a Kingshot gift code.")
    .addStringOption(option =>
      option
        .setName("code")
        .setDescription("Gift code")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("register")
    .setDescription("Register your Kingshot FID.")
    .addStringOption(option =>
      option
        .setName("fid")
        .setDescription("Your Kingshot FID / Player ID")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("name")
        .setDescription("Your in-game name")
        .setRequired(false)
    )
].map(command => command.toJSON());

let ashMode = "approval";
const members = new Map();
const usedCodes = new Set();

const rest = new REST({ version: "10" }).setToken(token);

async function registerCommands() {
  await rest.put(
    Routes.applicationGuildCommands(clientId, guildId),
    { body: commands }
  );
  console.log("Slash commands registered.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once("ready", () => {
  console.log(`ASH bot online as ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    await interaction.reply("ASH bot is online.");
  }

  if (interaction.commandName === "ashmode") {
    ashMode = interaction.options.getString("mode");
    await interaction.reply(`ASH gift-code mode set to **${ashMode}**.`);
  }

  if (interaction.commandName === "register") {
    const fid = interaction.options.getString("fid");
    const name = interaction.options.getString("name") || interaction.user.username;

    members.set(interaction.user.id, {
      fid,
      name,
      discord: interaction.user.username
    });

    await interaction.reply({
      content: `Registered **${name}** with FID **${fid}**.`,
      ephemeral: true
    });
  }

  if (interaction.commandName === "usecode") {
    const code = interaction.options.getString("code").toUpperCase();

    if (usedCodes.has(code)) {
      await interaction.reply(`Code **${code}** has already been submitted.`);
      return;
    }

    usedCodes.add(code);

    await interaction.reply(
      `ASH code received: **${code}**\nMode: **${ashMode}**\nRegistered FIDs: **${members.size}**\n\nReal Kingshot redemption will be connected after the Discord side is tested.`
    );
  }
});

client.on("messageCreate", async message => {
  if (message.author.bot) return;

  const matches = message.content.match(/\b[A-Z0-9]{6,20}\b/g);
  if (!matches) return;

  for (const possibleCode of matches) {
    if (usedCodes.has(possibleCode)) continue;

    await message.reply(
      `Possible Kingshot code detected: **${possibleCode}**\nCurrent mode: **${ashMode}**`
    );
  }
});

await registerCommands();
await client.login(token);

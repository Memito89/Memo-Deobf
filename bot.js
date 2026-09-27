const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN");
  process.exit(1);
}

if (!CLIENT_ID) {
  console.error("Missing CLIENT_ID");
  process.exit(1);
}

if (!GUILD_ID) {
  console.error("Missing GUILD_ID");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

const commands = [
  new SlashCommandBuilder()
    .setName("deobf")
    .setDescription("Analyze a Lua/Luau script")
    .addAttachmentOption(option =>
      option
        .setName("file")
        .setDescription("Lua/Luau file to analyze")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check if the bot is online"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show available commands")
].map(command => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  console.log("Registering slash commands...");

  await rest.put(
    Routes.applicationGuildCommands(
      CLIENT_ID,
      GUILD_ID
    ),
    {
      body: commands
    }
  );

  console.log("Slash commands registered successfully.");
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await registerCommands();
  } catch (error) {
    console.error("Could not register commands:");
    console.error(error);
  }
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    await interaction.reply("🏓 Pong!");
    return;
  }

  if (interaction.commandName === "help") {
    await interaction.reply({
      content:
        "**Lua Study Bot**\n\n" +
        "`/deobf file:` Analyze a Lua/Luau file\n" +
        "`/ping` Check whether the bot is online\n" +
        "`/help` Show this message",
      ephemeral: true
    });

    return;
  }

  if (interaction.commandName === "deobf") {
    const file = interaction.options.getAttachment("file");

    if (!file) {
      await interaction.reply({
        content: "❌ Please attach a Lua/Luau file.",
        ephemeral: true
      });

      return;
    }

    const allowedExtensions = [
      ".lua",
      ".luau",
      ".txt"
    ];

    const filename = file.name.toLowerCase();

    if (!allowedExtensions.some(ext => filename.endsWith(ext))) {
      await interaction.reply({
        content:
          "❌ Please upload a `.lua`, `.luau`, or `.txt` file.",
        ephemeral: true
      });

      return;
    }

    await interaction.reply({
      content:
        `📄 **${file.name}** received.\n\n` +
        `🔍 Starting static analysis...`,
      ephemeral: false
    });

    console.log(
      `Received file: ${file.name} from ${interaction.user.tag}`
    );

    // The actual analysis engine will go here.
    // For now, this only receives the file.
  }
});

client.on("error", error => {
  console.error("Discord client error:", error);
});

process.on("unhandledRejection", error => {
  console.error("Unhandled rejection:", error);
});

client.login(TOKEN);

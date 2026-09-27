const {
  Client,
  GatewayIntentBits
} = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const PREFIX = "!";

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (!message.content.startsWith(`${PREFIX}deobf`)) {
    return;
  }

  await message.reply(
    "Send your Lua/Luau file with `!deobf` and I'll analyze it."
  );
});

client.login(process.env.DISCORD_TOKEN);

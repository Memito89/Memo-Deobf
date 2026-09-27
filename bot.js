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

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const commands = [
  new SlashCommandBuilder()
    .setName("deobf")
    .setDescription("Analyze Lua/Luau source")
    .addStringOption(option =>
      option
        .setName("source")
        .setDescription("Paste Lua/Luau source")
        .setRequired(false)
    )
    .addAttachmentOption(option =>
      option
        .setName("file")
        .setDescription("Upload a Lua/Luau file")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("loadstring")
    .setDescription("Fetch a raw Lua source URL")
    .addStringOption(option =>
      option
        .setName("url")
        .setDescription("Raw HTTP/HTTPS Lua source URL")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check whether the bot is online")
].map(command => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("Slash commands registered.");
}

function extractUrls(source) {
  const urls = new Set();

  const regex = /https?:\/\/[^\s"'`)<>\]}]+/gi;

  for (const match of source.matchAll(regex)) {
    urls.add(match[0].replace(/[.,;]+$/, ""));
  }

  return [...urls];
}

function findLoadStrings(source) {
  const results = [];

  const regex =
    /loadstring\s*\(\s*(?:game\s*:\s*)?HttpGet\s*\(\s*["']([^"']+)["']/gi;

  for (const match of source.matchAll(regex)) {
    results.push(match[1]);
  }

  return [...new Set(results)];
}

function analyzeLua(source) {
  const patterns = [];

  if (/\bloadstring\s*\(/i.test(source))
    patterns.push("loadstring");

  if (/\bHttpGet\s*\(/i.test(source))
    patterns.push("HttpGet");

  if (/\bstring\.char\s*\(/i.test(source))
    patterns.push("string.char");

  if (/\bstring\.byte\s*\(/i.test(source))
    patterns.push("string.byte");

  if (/\bsetmetatable\s*\(/i.test(source))
    patterns.push("setmetatable");

  return {
    lines: source.split(/\r?\n/).length,
    characters: source.length,
    functions: (source.match(/\bfunction\b/g) || []).length,
    patterns,
    urls: extractUrls(source),
    loadStrings: findLoadStrings(source)
  };
}

/*
 * Only fetches HTTP/HTTPS source.
 * Never executes the returned Lua.
 */
async function fetchRawSource(url) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are allowed.");
  }

  const response = await fetch(parsed.href, {
    redirect: "follow",
    headers: {
      "User-Agent": "Lua-Study-Analyzer/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText}`
    );
  }

  const text = await response.text();

  if (text.length > 2_000_000) {
    throw new Error("Remote source is larger than 2 MB.");
  }

  return text;
}

async function handleLoadstring(interaction, url) {
  await interaction.deferReply();

  try {
    const source = await fetchRawSource(url);
    const analysis = analyzeLua(source);

    let output =
      `## Raw Source\n` +
      `**URL:** ${url}\n` +
      `**Size:** ${source.length} characters\n\n`;

    /*
     * Discord messages cannot contain unlimited source.
     * Show the first 3500 characters in a code block.
     */
    const preview = source.slice(0, 3500);

    output += "```lua\n";
    output += preview;
    output += "\n```";

    if (source.length > 3500) {
      output +=
        `\n\n⚠️ Showing first 3500 characters of ` +
        `${source.length} total characters.`;
    }

    output += "\n\n### Detected patterns\n";

    if (analysis.patterns.length) {
      output += analysis.patterns
        .map(x => `- \`${x}\``)
        .join("\n");
    } else {
      output += "- None detected";
    }

    output += "\n\n### Nested loadstring URLs\n";

    if (analysis.loadStrings.length) {
      output += analysis.loadStrings
        .map(x => `- ${x}`)
        .join("\n");
    } else {
      output += "- None found";
    }

    await interaction.editReply({
      content: output
    });

  } catch (error) {
    console.error(error);

    await interaction.editReply(
      `❌ Could not fetch the source:\n\`${error.message}\``
    );
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await registerCommands();
  } catch (error) {
    console.error("Command registration failed:", error);
  }
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    await interaction.reply("🏓 Pong!");
    return;
  }

  if (interaction.commandName === "loadstring") {
    const url = interaction.options.getString("url");

    await handleLoadstring(interaction, url);
    return;
  }

  if (interaction.commandName === "deobf") {
    const source =
      interaction.options.getString("source");

    const file =
      interaction.options.getAttachment("file");

    if (!source && !file) {
      await interaction.reply({
        content:
          "❌ Provide Lua source or upload a `.lua`/`.luau` file.",
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply();

    try {
      let luaSource = source;

      if (!luaSource && file) {
        const response = await fetch(file.url);

        if (!response.ok) {
          throw new Error("Could not download Discord attachment.");
        }

        luaSource = await response.text();
      }

      const analysis = analyzeLua(luaSource);

      let output =
        `## Lua Analysis\n\n` +
        `**Lines:** ${analysis.lines}\n` +
        `**Characters:** ${analysis.characters}\n` +
        `**Functions:** ${analysis.functions}\n\n`;

      output += "### Detected patterns\n";

      output += analysis.patterns.length
        ? analysis.patterns.map(x => `- \`${x}\``).join("\n")
        : "- None detected";

      output += "\n\n### Loadstring URLs\n";

      output += analysis.loadStrings.length
        ? analysis.loadStrings.map(x => `- ${x}`).join("\n")
        : "- None found";

      output += "\n\nUse `/loadstring url:<URL>` to fetch a source URL.";

      await interaction.editReply(output);

    } catch (error) {
      console.error(error);

      await interaction.editReply(
        `❌ Analysis failed: ${error.message}`
      );
    }
  }
});

client.login(TOKEN);

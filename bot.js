const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error(
    "Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID Railway variable."
  );
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const commands = [
  new SlashCommandBuilder()
    .setName("deobf")
    .setDescription("Analyze Lua/Luau source code")
    .addStringOption(option =>
      option
        .setName("source")
        .setDescription("Paste Lua/Luau source code")
        .setRequired(false)
    )
    .addAttachmentOption(option =>
      option
        .setName("file")
        .setDescription("Upload a Lua/Luau file")
        .setRequired(false)
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

/*
 * Extract URLs from Lua source.
 *
 * This only extracts them.
 * It does NOT request, execute, or download them.
 */
function extractUrls(source) {
  const urls = new Set();

  const regex = /https?:\/\/[^\s"'`)<>\]}]+/gi;

  for (const match of source.matchAll(regex)) {
    urls.add(match[0].replace(/[.,;]+$/, ""));
  }

  return [...urls];
}

/*
 * Find common loadstring/HttpGet patterns.
 */
function findLoadStrings(source) {
  const results = [];

  const patterns = [
    /loadstring\s*\(\s*game\s*:\s*HttpGet\s*\(\s*["']([^"']+)["']/gi,
    /loadstring\s*\(\s*game\s*\.\s*HttpGet\s*\(\s*["']([^"']+)["']/gi,
    /loadstring\s*\(\s*http_request\s*\(\s*["']([^"']+)["']/gi,
    /loadstring\s*\(\s*request\s*\(\s*["']([^"']+)["']/gi
  ];

  for (const regex of patterns) {
    for (const match of source.matchAll(regex)) {
      results.push(match[1]);
    }
  }

  return [...new Set(results)];
}

function analyzeLua(source) {
  const urls = extractUrls(source);
  const loadStrings = findLoadStrings(source);

  const patterns = [];

  if (/\bloadstring\s*\(/i.test(source)) {
    patterns.push("loadstring");
  }

  if (/\bHttpGet\s*\(/i.test(source)) {
    patterns.push("HttpGet");
  }

  if (/\bstring\.char\s*\(/i.test(source)) {
    patterns.push("string.char");
  }

  if (/\bstring\.byte\s*\(/i.test(source)) {
    patterns.push("string.byte");
  }

  if (/\bbit32\./i.test(source)) {
    patterns.push("bit32 operations");
  }

  if (/\bdebug\./i.test(source)) {
    patterns.push("debug library");
  }

  if (/\bsetmetatable\s*\(/i.test(source)) {
    patterns.push("metatable usage");
  }

  if (/\bgetmetatable\s*\(/i.test(source)) {
    patterns.push("metatable access");
  }

  if (/\btable\.concat\s*\(/i.test(source)) {
    patterns.push("table concatenation");
  }

  return {
    lines: source.split(/\r?\n/).length,
    characters: source.length,
    functions: (source.match(/\bfunction\b/g) || []).length,
    patterns,
    urls,
    loadStrings
  };
}

function formatAnalysis(result) {
  let output = "";

  output += "## Lua Analysis\n\n";

  output += `**Lines:** ${result.lines}\n`;
  output += `**Characters:** ${result.characters}\n`;
  output += `**Functions:** ${result.functions}\n\n`;

  output += "### Detected patterns\n";

  if (result.patterns.length) {
    for (const pattern of result.patterns) {
      output += `- \`${pattern}\`\n`;
    }
  } else {
    output += "- None detected\n";
  }

  output += "\n### Extracted loadstring URLs\n";

  if (result.loadStrings.length) {
    for (const url of result.loadStrings) {
      output += `- ${url}\n`;
    }
  } else {
    output += "- None found\n";
  }

  output += "\n### Other URLs\n";

  if (result.urls.length) {
    for (const url of result.urls) {
      output += `- ${url}\n`;
    }
  } else {
    output += "- None found\n";
  }

  return output;
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await registerCommands();
  } catch (error) {
    console.error("Command registration failed:");
    console.error(error);
  }
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "ping") {
    await interaction.reply("🏓 Pong!");
    return;
  }

  if (interaction.commandName !== "deobf") return;

  const source = interaction.options.getString("source");
  const file = interaction.options.getAttachment("file");

  if (!source && !file) {
    await interaction.reply({
      content:
        "❌ Provide either `source` or a Lua/Luau file.",
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply();

  try {
    let luaSource = source;

    if (!luaSource && file) {
      const allowed = [
        ".lua",
        ".luau",
        ".txt"
      ];

      const filename = file.name.toLowerCase();

      if (!allowed.some(ext => filename.endsWith(ext))) {
        await interaction.editReply(
          "❌ Upload a `.lua`, `.luau`, or `.txt` file."
        );
        return;
      }

      const response = await fetch(file.url);

      if (!response.ok) {
        throw new Error("Could not read the Discord attachment.");
      }

      luaSource = await response.text();
    }

    if (!luaSource || !luaSource.trim()) {
      await interaction.editReply("❌ No Lua source was provided.");
      return;
    }

    // Prevent accidentally processing enormous pasted input.
    if (luaSource.length > 2_000_000) {
      await interaction.editReply(
        "❌ Source is too large. Maximum is 2 MB."
      );
      return;
    }

    const result = analyzeLua(luaSource);
    const report = formatAnalysis(result);

    if (report.length <= 1900) {
      await interaction.editReply(report);
    } else {
      const chunks = [];

      for (let i = 0; i < report.length; i += 1800) {
        chunks.push(report.slice(i, i + 1800));
      }

      await interaction.editReply(chunks[0]);

      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(chunks[i]);
      }
    }

    console.log(
      `Analyzed Lua from ${interaction.user.tag}`
    );
  } catch (error) {
    console.error(error);

    await interaction.editReply(
      "❌ Analysis failed. Check the Railway logs."
    );
  }
});

client.on("error", error => {
  console.error("Discord error:", error);
});

process.on("unhandledRejection", error => {
  console.error("Unhandled rejection:", error);
});

client.login(TOKEN);

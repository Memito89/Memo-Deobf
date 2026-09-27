const express = require("express");
const multer = require("multer");
const crypto = require("crypto");

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
  console.error(
    "Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID."
  );
  process.exit(1);
}

/*
 * ---------------------------------------------------------
 * WEB SERVER
 * ---------------------------------------------------------
 */

const app = express();

const rawFiles = new Map();

app.get("/", (req, res) => {
  res.send("Lua source service online.");
});

/*
 * Returns uploaded source as plain text.
 *
 * Example:
 * https://your-project.up.railway.app/raw/abc123
 */
app.get("/raw/:id", (req, res) => {
  const source = rawFiles.get(req.params.id);

  if (!source) {
    return res.status(404).send("Source not found.");
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  res.send(source);
});

const upload = multer({
  limits: {
    fileSize: 2 * 1024 * 1024
  }
});

/*
 * ---------------------------------------------------------
 * DISCORD
 * ---------------------------------------------------------
 */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

const commands = [
  new SlashCommandBuilder()
    .setName("deobf")
    .setDescription("Resolve and analyze Lua/Luau source")
    .addStringOption(option =>
      option
        .setName("input")
        .setDescription(
          "Lua source, loadstring, or raw HTTP/HTTPS URL"
        )
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
  const rest = new REST({
    version: "10"
  }).setToken(TOKEN);

  console.log("Registering commands...");

  await rest.put(
    Routes.applicationGuildCommands(
      CLIENT_ID,
      GUILD_ID
    ),
    {
      body: commands
    }
  );

  console.log("Commands registered.");
}

/*
 * ---------------------------------------------------------
 * SOURCE HELPERS
 * ---------------------------------------------------------
 */

/*
 * Extract HTTP/HTTPS URLs from arbitrary text.
 */
function extractUrls(text) {
  const regex =
    /https?:\/\/[^\s"'`<>()$begin:math:display$$end:math:display${}]+/gi;

  return [
    ...new Set(
      [...text.matchAll(regex)]
        .map(match =>
          match[0].replace(/[.,;]+$/, "")
        )
    )
  ];
}

/*
 * Specifically detect common Roblox-style:
 *
 * loadstring(game:HttpGet("URL"))()
 *
 * Also accepts:
 *
 * loadstring(game.HttpGet("URL"))()
 */
function extractLoadstringUrls(text) {
  const urls = new Set();

  const patterns = [
    /loadstring\s*\(\s*game\s*:\s*HttpGet\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/gi,

    /loadstring\s*\(\s*game\s*\.\s*HttpGet\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/gi,

    /loadstring\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]\s*\)/gi
  ];

  for (const regex of patterns) {
    for (const match of text.matchAll(regex)) {
      urls.add(match[1]);
    }
  }

  return [...urls];
}

/*
 * If the user enters:
 *
 * https://example.com/script.lua
 *
 * return that URL.
 *
 * If they enter:
 *
 * loadstring(game:HttpGet("https://..."))()
 *
 * return the URL inside it.
 */
function resolveInput(input) {
  const loadstringUrls =
    extractLoadstringUrls(input);

  if (loadstringUrls.length > 0) {
    return loadstringUrls[0];
  }

  const urls = extractUrls(input);

  if (urls.length > 0) {
    return urls[0];
  }

  return null;
}

/*
 * ---------------------------------------------------------
 * REMOTE SOURCE FETCHING
 * ---------------------------------------------------------
 */

async function fetchSource(url) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (
    parsed.protocol !== "https:" &&
    parsed.protocol !== "http:"
  ) {
    throw new Error(
      "Only HTTP/HTTPS URLs are supported."
    );
  }

  const response = await fetch(parsed.href, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Lua-Study-Bot/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Remote server returned HTTP ${response.status}.`
    );
  }

  const source = await response.text();

  if (source.length > 2_000_000) {
    throw new Error(
      "Remote source is larger than 2 MB."
    );
  }

  return source;
}

/*
 * ---------------------------------------------------------
 * RAW SOURCE PUBLISHER
 * ---------------------------------------------------------
 */

function publishSource(source) {
  const id =
    crypto.randomBytes(12).toString("hex");

  rawFiles.set(id, source);

  /*
   * Automatically remove after 1 hour.
   */
  setTimeout(() => {
    rawFiles.delete(id);
  }, 60 * 60 * 1000);

  const base =
    process.env.PUBLIC_URL ||
    `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;

  return `${base}/raw/${id}`;
}

/*
 * ---------------------------------------------------------
 * STATIC ANALYSIS
 * ---------------------------------------------------------
 */

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

  if (/\bgetmetatable\s*\(/i.test(source))
    patterns.push("getmetatable");

  if (/\bbit32\./i.test(source))
    patterns.push("bit32");

  return {
    lines:
      source.split(/\r?\n/).length,

    characters:
      source.length,

    functions:
      (source.match(/\bfunction\b/g) || []).length,

    patterns,

    loadstringUrls:
      extractLoadstringUrls(source),

    urls:
      extractUrls(source)
  };
}

/*
 * ---------------------------------------------------------
 * DISCORD COMMAND
 * ---------------------------------------------------------
 */

client.once("ready", async () => {
  console.log(
    `Logged in as ${client.user.tag}`
  );

  try {
    await registerCommands();
  } catch (error) {
    console.error(
      "Command registration failed:",
      error
    );
  }
});

client.on(
  "interactionCreate",
  async interaction => {
    if (!interaction.isChatInputCommand())
      return;

    if (
      interaction.commandName === "ping"
    ) {
      await interaction.reply(
        "🏓 Pong!"
      );
      return;
    }

    if (
      interaction.commandName !== "deobf"
    ) {
      return;
    }

    const input =
      interaction.options.getString(
        "input"
      );

    const file =
      interaction.options.getAttachment(
        "file"
      );

    if (!input && !file) {
      await interaction.reply({
        content:
          "❌ Provide Lua source, a loadstring/raw URL, or upload a Lua file.",
        ephemeral: true
      });

      return;
    }

    await interaction.deferReply();

    try {
      let source = null;
      let originalInput = null;

      /*
       * FILE
       */
      if (file) {
        const filename =
          file.name.toLowerCase();

        const allowed = [
          ".lua",
          ".luau",
          ".txt"
        ];

        if (
          !allowed.some(ext =>
            filename.endsWith(ext)
          )
        ) {
          throw new Error(
            "Only .lua, .luau, or .txt files are supported."
          );
        }

        const response =
          await fetch(file.url);

        if (!response.ok) {
          throw new Error(
            "Could not download the Discord attachment."
          );
        }

        source =
          await response.text();

        originalInput =
          `Uploaded file: ${file.name}`;
      }

      /*
       * TEXT / LOADSTRING / URL
       */
      else if (input) {
        const remoteUrl =
          resolveInput(input);

        /*
         * Raw URL or loadstring
         */
        if (remoteUrl) {
          source =
            await fetchSource(
              remoteUrl
            );

          originalInput =
            remoteUrl;
        }

        /*
         * Plain Lua source
         */
        else {
          source = input;

          originalInput =
            "Pasted Lua source";
        }
      }

      if (!source) {
        throw new Error(
          "No source could be resolved."
        );
      }

      if (
        source.length >
        2_000_000
      ) {
        throw new Error(
          "Source is larger than 2 MB."
        );
      }

      /*
       * Publish the resolved source.
       */
      const rawUrl =
        publishSource(source);

      /*
       * Analyze it.
       */
      const analysis =
        analyzeLua(source);

      let message =
        "## ✅ Source Resolved\n\n";

      message +=
        `**Input:** ${originalInput}\n`;

      message +=
        `**Size:** ${source.length.toLocaleString()} characters\n`;

      message +=
        `**Lines:** ${analysis.lines.toLocaleString()}\n\n`;

      message +=
        `### 🔗 Raw Source\n${rawUrl}\n\n`;

      message +=
        "### 🔍 Detected\n";

      if (
        analysis.patterns.length
      ) {
        message +=
          analysis.patterns
            .map(x => `- \`${x}\``)
            .join("\n");
      } else {
        message +=
          "- No known patterns detected.";
      }

      /*
       * Show nested loadstring URLs.
       */
      if (
        analysis.loadstringUrls.length
      ) {
        message +=
          "\n\n### 🔗 Nested Loadstrings\n";

        message +=
          analysis.loadstringUrls
            .map(
              url =>
                `- ${url}`
            )
            .join("\n");
      }

      /*
       * Keep Discord message under 2000.
       */
      if (message.length > 1900) {
        message =
          message.slice(0, 1800) +
          "\n\n...more results available from the raw source.";
      }

      await interaction.editReply(
        message
      );

    } catch (error) {
      console.error(error);

      await interaction.editReply(
        `❌ **Failed:** ${error.message}`
      );
    }
  }
);

client.on(
  "error",
  error => {
    console.error(
      "Discord error:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "Unhandled rejection:",
      error
    );
  }
);

client.login(TOKEN);

/*
 * ---------------------------------------------------------
 * START WEB SERVER
 * ---------------------------------------------------------
 */

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Raw source server listening on ${PORT}`
    );
  }
);

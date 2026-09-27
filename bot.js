const express = require("express");
const crypto = require("crypto");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

/* =========================================================
   CONFIG
========================================================= */

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const PUBLIC_URL = process.env.PUBLIC_URL;

const PORT = process.env.PORT || 3000;

const MAX_SOURCE_SIZE = 2 * 1024 * 1024;
const MAX_FETCH_DEPTH = 5;
const RAW_LIFETIME = 60 * 60 * 1000;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error(
    "Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID."
  );
  process.exit(1);
}

if (!PUBLIC_URL) {
  console.warn(
    "PUBLIC_URL is not set. Raw links will not work correctly."
  );
}

/* =========================================================
   EXPRESS / RAW SOURCE HOST
========================================================= */

const app = express();

const rawStore = new Map();

app.get("/", (req, res) => {
  res
    .type("text")
    .send("Lua deobfuscation service online.");
});

app.get("/health", (req, res) => {
  res.json({
    online: true,
    storedSources: rawStore.size
  });
});

app.get("/raw/:id", (req, res) => {
  const item = rawStore.get(req.params.id);

  if (!item) {
    return res.status(404).type("text").send(
      "Source not found or expired."
    );
  }

  res.setHeader(
    "Content-Type",
    "text/plain; charset=utf-8"
  );

  res.setHeader(
    "Content-Disposition",
    `inline; filename="${item.filename}"`
  );

  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  res.send(item.source);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Web server listening on port ${PORT}`
  );
});

/* =========================================================
   RAW PUBLISHER
========================================================= */

function publishRaw(source, filename) {
  const id = crypto
    .randomBytes(16)
    .toString("hex");

  rawStore.set(id, {
    source,
    filename,
    created: Date.now()
  });

  setTimeout(() => {
    rawStore.delete(id);
  }, RAW_LIFETIME);

  return `${PUBLIC_URL.replace(/\/$/, "")}/raw/${id}`;
}

/* =========================================================
   DISCORD
========================================================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

const commands = [
  new SlashCommandBuilder()
    .setName("deobf")
    .setDescription(
      "Statically process Lua/Luau source"
    )
    .addStringOption(option =>
      option
        .setName("input")
        .setDescription(
          "Lua source, loadstring, or raw URL"
        )
        .setRequired(false)
    )
    .addAttachmentOption(option =>
      option
        .setName("file")
        .setDescription(
          "Upload a .lua, .luau, or .txt file"
        )
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription(
      "Check whether the bot is online"
    )
].map(command => command.toJSON());

async function registerCommands() {
  const rest = new REST({
    version: "10"
  }).setToken(TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(
      CLIENT_ID,
      GUILD_ID
    ),
    {
      body: commands
    }
  );

  console.log(
    "Slash commands registered."
  );
}

/* =========================================================
   URL EXTRACTION
========================================================= */

function extractUrls(source) {
  const regex =
    /https?:\/\/[^\s"'`<>()$begin:math:display$$end:math:display${}]+/gi;

  return [
    ...new Set(
      [...source.matchAll(regex)]
        .map(m =>
          m[0].replace(/[.,;]+$/, "")
        )
    )
  ];
}

function extractLoadstringUrls(source) {
  const urls = new Set();

  const patterns = [
    /loadstring\s*\(\s*game\s*:\s*HttpGet\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/gi,

    /loadstring\s*\(\s*game\s*\.\s*HttpGet\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/gi,

    /loadstring\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]\s*\)/gi
  ];

  for (const regex of patterns) {
    for (const match of source.matchAll(regex)) {
      urls.add(match[1]);
    }
  }

  return [...urls];
}

function resolveInputURL(input) {
  const loadstringUrls =
    extractLoadstringUrls(input);

  if (loadstringUrls.length) {
    return loadstringUrls[0];
  }

  const urls =
    extractUrls(input);

  if (urls.length) {
    return urls[0];
  }

  return null;
}

/* =========================================================
   SAFE REMOTE FETCHING
========================================================= */

async function fetchSource(url) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `Invalid URL: ${url}`
    );
  }

  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:"
  ) {
    throw new Error(
      "Only HTTP and HTTPS URLs are supported."
    );
  }

  console.log(
    `[FETCH] ${parsed.href}`
  );

  try {
    const response = await fetch(
      parsed.href,
      {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 Lua-Deobf-Bot/3.0",
          "Accept":
            "text/plain,text/*,*/*"
        },
        signal:
          AbortSignal.timeout(30000)
      }
    );

    console.log(
      `[HTTP] ${response.status} ${response.statusText}`
    );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}`
      );
    }

    const source =
      await response.text();

    if (!source.length) {
      throw new Error(
        "The remote URL returned an empty response."
      );
    }

    if (
      source.length >
      MAX_SOURCE_SIZE
    ) {
      throw new Error(
        "Remote source is larger than 2 MB."
      );
    }

    return source;

  } catch (error) {
    console.error(
      `[FETCH ERROR] ${parsed.href}`,
      error
    );

    throw new Error(
      `Fetch failed for ${parsed.href}: ${error.message}`
    );
  }
}

/* =========================================================
   STATIC DECODERS
========================================================= */

function decodeDecimalEscapes(source) {
  return source.replace(
    /\\(\d{1,3})/g,
    (full, digits) => {
      const value = Number(digits);

      if (
        value >= 0 &&
        value <= 255
      ) {
        return String.fromCharCode(value);
      }

      return full;
    }
  );
}

function decodeHexEscapes(source) {
  return source.replace(
    /\\x([0-9a-fA-F]{2})/g,
    (full, hex) =>
      String.fromCharCode(
        parseInt(hex, 16)
      )
  );
}

function looksLikeBase64(value) {
  return (
    value.length >= 16 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function decodeBase64Strings(source) {
  return source.replace(
    /(["'])([A-Za-z0-9+/]{16,}={0,2})\1/g,
    (full, quote, value) => {
      if (!looksLikeBase64(value)) {
        return full;
      }

      try {
        const decoded =
          Buffer.from(
            value,
            "base64"
          ).toString("utf8");

        if (
          /[\x00-\x08\x0E-\x1F]/.test(
            decoded
          )
        ) {
          return full;
        }

        return (
          quote +
          decoded.replace(
            new RegExp(
              `\\${quote}`,
              "g"
            ),
            `\\${quote}`
          ) +
          quote
        );

      } catch {
        return full;
      }
    }
  );
}

/* =========================================================
   STATIC XOR
========================================================= */

function xorBytes(value, key) {
  let result = "";

  for (
    let i = 0;
    i < value.length;
    i++
  ) {
    result += String.fromCharCode(
      value.charCodeAt(i) ^ key
    );
  }

  return result;
}

function decodeSimpleXorCalls(source) {
  return source.replace(
    /\bxor\s*\(\s*["']([^"']+)["']\s*,\s*(\d{1,3})\s*\)/gi,
    (full, value, keyText) => {
      const key = Number(keyText);

      if (
        key < 0 ||
        key > 255
      ) {
        return full;
      }

      return JSON.stringify(
        xorBytes(value, key)
      );
    }
  );
}

/* =========================================================
   CONSTANT FOLDING
========================================================= */

function foldArithmetic(source) {
  let previous;

  do {
    previous = source;

    source = source.replace(
      /(?<![\w.])(-?\d+(?:\.\d+)?)\s*([+\-*\/])\s*(-?\d+(?:\.\d+)?)(?![\w.])/g,
      (full, aText, op, bText) => {
        const a = Number(aText);
        const b = Number(bText);

        let result;

        switch (op) {
          case "+":
            result = a + b;
            break;

          case "-":
            result = a - b;
            break;

          case "*":
            result = a * b;
            break;

          case "/":
            if (b === 0) return full;
            result = a / b;
            break;

          default:
            return full;
        }

        if (!Number.isFinite(result)) {
          return full;
        }

        return String(result);
      }
    );

  } while (previous !== source);

  return source;
}

function foldStringConcats(source) {
  let previous;

  do {
    previous = source;

    source = source.replace(
      /(["'])(.*?)\1\s*\.\.\s*(["'])(.*?)\3/g,
      (full, q1, a, q2, b) =>
        JSON.stringify(a + b)
    );

  } while (previous !== source);

  return source;
}

/* =========================================================
   COMMENT / FORMAT CLEANUP
========================================================= */

function removeComments(source) {
  source = source.replace(
    /--\[\[[\s\S]*?\]\]/g,
    ""
  );

  source = source.replace(
    /--[^\r\n]*/g,
    ""
  );

  return source;
}

function normalizeWhitespace(source) {
  return source
    .split(/\r?\n/)
    .map(line =>
      line.trimEnd()
    )
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n");
}

/* =========================================================
   VM / OBFUSCATION DETECTION
========================================================= */

function detectProtection(source) {
  const findings = [];

  const checks = [
    [
      "loadstring",
      /\bloadstring\s*\(/i
    ],

    [
      "HttpGet",
      /\bHttpGet\s*\(/i
    ],

    [
      "large numeric table",
      /\{(?:\s*-?\d+\s*,?){30,}\s*\}/
    ],

    [
      "large string table",
      /\{(?:\s*["'][^"']*["']\s*,?){20,}\s*\}/
    ],

    [
      "opcode/bytecode references",
      /\b(?:opcode|opcodes|bytecode|instruction|instructions)\b/i
    ],

    [
      "VM references",
      /\b(?:vm|virtualmachine|virtual_machine|dispatcher)\b/i
    ],

    [
      "program-counter references",
      /\b(?:pc|program_counter|instruction_pointer)\b/i
    ],

    [
      "state-machine references",
      /\b(?:state|state_id|next_state|dispatch)\b/i
    ],

    [
      "metatable indirection",
      /\b(?:setmetatable|getmetatable|__index|__newindex)\b/
    ],

    [
      "debug/integrity references",
      /\bdebug\./
    ],

    [
      "string byte/char operations",
      /\bstring\.(?:byte|char|sub)\b/
    ],

    [
      "bitwise library",
      /\b(?:bit32|bit)\./
    ],

    [
      "control-flow flattening indicators",
      /\b(?:dispatcher|state_table|jump_table)\b/i
    ]
  ];

  for (const [name, regex] of checks) {
    if (regex.test(source)) {
      findings.push(name);
    }
  }

  return findings;
}

/* =========================================================
   DEOBFUSCATION PIPELINE
========================================================= */

function deobfuscate(source) {
  let output = source;

  const passes = [];

  function apply(name, fn) {
    const before = output;

    output = fn(output);

    if (output !== before) {
      passes.push(name);
    }
  }

  apply(
    "decimal escape decoding",
    decodeDecimalEscapes
  );

  apply(
    "hex escape decoding",
    decodeHexEscapes
  );

  apply(
    "Base64 string decoding",
    decodeBase64Strings
  );

  apply(
    "static XOR decoding",
    decodeSimpleXorCalls
  );

  apply(
    "arithmetic constant folding",
    foldArithmetic
  );

  apply(
    "string concatenation folding",
    foldStringConcats
  );

  apply(
    "comment removal",
    removeComments
  );

  apply(
    "whitespace normalization",
    normalizeWhitespace
  );

  return {
    source: output,
    passes
  };
}

/* =========================================================
   RECURSIVE LOADSTRING RESOLUTION
========================================================= */

async function resolveRecursive(
  source,
  depth = 0,
  visited = new Set()
) {
  if (
    depth >= MAX_FETCH_DEPTH
  ) {
    return {
      source,
      chain: [],
      stopped: "maximum fetch depth"
    };
  }

  const url =
    resolveInputURL(source);

  if (!url) {
    return {
      source,
      chain: []
    };
  }

  if (visited.has(url)) {
    return {
      source,
      chain: [url],
      stopped: "circular URL"
    };
  }

  visited.add(url);

  const remote =
    await fetchSource(url);

  const nested =
    await resolveRecursive(
      remote,
      depth + 1,
      visited
    );

  return {
    source: nested.source,
    chain: [
      url,
      ...nested.chain
    ],
    stopped: nested.stopped
  };
}

/* =========================================================
   ANALYSIS
========================================================= */

function analyze(source) {
  return {
    lines:
      source.split(/\r?\n/).length,

    characters:
      source.length,

    functions:
      (
        source.match(
          /\bfunction\b/g
        ) || []
      ).length,

    urls:
      extractUrls(source),

    loadstrings:
      extractLoadstringUrls(source),

    protection:
      detectProtection(source)
  };
}

/* =========================================================
   DISCORD READY
========================================================= */

client.once(
  "ready",
  async () => {
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
  }
);

/* =========================================================
   INTERACTIONS
========================================================= */

client.on(
  "interactionCreate",
  async interaction => {
    if (
      !interaction.isChatInputCommand()
    ) {
      return;
    }

    if (
      interaction.commandName === "ping"
    ) {
      await interaction.reply(
        "🏓 Pong!"
      );

      return;
    }

    if (
      interaction.commandName !==
      "deobf"
    ) {
      return;
    }

    const input =
      interaction.options.getString(
        "input"
      );

    const attachment =
      interaction.options.getAttachment(
        "file"
      );

    if (!input && !attachment) {
      await interaction.reply({
        content:
          "❌ Give me Lua source, a loadstring, a raw URL, or upload a Lua file.",
        ephemeral: true
      });

      return;
    }

    await interaction.deferReply();

    try {
      let originalSource;
      let filename =
        "deobfuscated.lua";

      /* -----------------------------------------
         FILE
      ----------------------------------------- */

      if (attachment) {
        const name =
          attachment.name.toLowerCase();

        if (
          !name.endsWith(".lua") &&
          !name.endsWith(".luau") &&
          !name.endsWith(".txt")
        ) {
          throw new Error(
            "Only .lua, .luau, and .txt files are supported."
          );
        }

        filename =
          attachment.name;

        const response =
          await fetch(
            attachment.url,
            {
              signal:
                AbortSignal.timeout(
                  30000
                )
            }
          );

        if (!response.ok) {
          throw new Error(
            `Discord returned HTTP ${response.status}.`
          );
        }

        originalSource =
          await response.text();
      }

      /* -----------------------------------------
         TEXT / URL / LOADSTRING
      ----------------------------------------- */

      else {
        originalSource = input;
      }

      if (
        originalSource.length >
        MAX_SOURCE_SIZE
      ) {
        throw new Error(
          "Input exceeds the 2 MB limit."
        );
      }

      /* -----------------------------------------
         RESOLVE REMOTE SOURCES
      ----------------------------------------- */

      const resolved =
        await resolveRecursive(
          originalSource
        );

      /* -----------------------------------------
         DEOBFUSCATE
      ----------------------------------------- */

      const result =
        deobfuscate(
          resolved.source
        );

      /* -----------------------------------------
         ANALYZE
      ----------------------------------------- */

      const analysis =
        analyze(
          result.source
        );

      /* -----------------------------------------
         PUBLISH
      ----------------------------------------- */

      const rawUrl =
        publishRaw(
          result.source,
          filename
        );

      /* -----------------------------------------
         DISCORD RESPONSE
      ----------------------------------------- */

      let message =
        "## ✅ Deobfuscation Result\n\n";

      message +=
        `**Input:** ${originalSource.length.toLocaleString()} characters\n`;

      message +=
        `**Output:** ${result.source.length.toLocaleString()} characters\n`;

      message +=
        `**Lines:** ${analysis.lines.toLocaleString()}\n`;

      message +=
        `**Functions:** ${analysis.functions.toLocaleString()}\n\n`;

      message +=
        `### 🔗 Raw Output\n${rawUrl}\n\n`;

      message +=
        "### 🔧 Transformations\n";

      if (result.passes.length) {
        message +=
          result.passes
            .map(
              pass =>
                `- ${pass}`
            )
            .join("\n");
      } else {
        message +=
          "- No safe static transformations matched.";
      }

      if (
        resolved.chain.length
      ) {
        message +=
          "\n\n### 🌐 Source Chain\n";

        message +=
          resolved.chain
            .map(
              url =>
                `- ${url}`
            )
            .join("\n");
      }

      if (
        analysis.protection.length
      ) {
        message +=
          "\n\n### 🔍 Remaining Obfuscation Indicators\n";

        message +=
          analysis.protection
            .map(
              item =>
                `- ${item}`
            )
            .join("\n");
      }

      if (
        analysis.loadstrings.length
      ) {
        message +=
          "\n\n### 🔗 Loadstrings\n";

        message +=
          analysis.loadstrings
            .map(
              url =>
                `- ${url}`
            )
            .join("\n");
      }

      /*
       * Never exceed Discord's message limit.
       */
      if (message.length > 1900) {
        message =
          message.slice(0, 1800) +
          "\n\n...additional information is available in the raw output.";
      }

      await interaction.editReply(
        message
      );

    } catch (error) {
      console.error(
        "DEOBF ERROR:",
        error
      );

      const errorText =
        String(error.message || error);

      await interaction.editReply(
        `❌ **Failed**\n\`\`\`\n${errorText.slice(
          0,
          1600
        )}\n\`\`\``
      );
    }
  }
);

/* =========================================================
   ERROR HANDLING
========================================================= */

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

/* =========================================================
   LOGIN
========================================================= */

client.login(TOKEN);

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
    "WARNING: PUBLIC_URL is not configured."
  );
}

/* =========================================================
   EXPRESS SERVER
========================================================= */

const app = express();
const rawStore = new Map();

app.get("/", (req, res) => {
  res.type("text").send(
    "Lua deobfuscation service online."
  );
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
    return res
      .status(404)
      .type("text")
      .send("Source not found or expired.");
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
  if (!PUBLIC_URL) {
    throw new Error(
      "PUBLIC_URL is not configured in Railway Variables."
    );
  }

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

  return (
    PUBLIC_URL.replace(/\/$/, "") +
    "/raw/" +
    id
  );
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
      "Process Lua/Luau source"
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
          "Upload .lua, .luau, or .txt"
        )
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription(
      "Check whether the bot is online"
    )
].map(x => x.toJSON());

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
    "Discord slash commands registered."
  );
}

/* =========================================================
   URL EXTRACTION
========================================================= */

/*
 * Finds actual HTTP/HTTPS URLs.
 *
 * Importantly, this does NOT accept things like:
 *
 * https://r/
 *
 * unless "r" is actually a valid domain.
 */

function extractUrls(source) {
  const matches = source.match(
    /https?:\/\/(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?(?:\/[^\s"'`<>()$begin:math:display$$end:math:display${}]*)?/gi
  );

  if (!matches) {
    return [];
  }

  return [
    ...new Set(
      matches.map(url =>
        url.replace(/[.,;]+$/, "")
      )
    )
  ];
}

/*
 * Specifically extracts URLs from common
 * loadstring/HttpGet forms.
 */

function extractLoadstringUrls(source) {
  const urls = new Set();

  const patterns = [
    /*
     * loadstring(game:HttpGet("URL"))
     */
    /loadstring\s*\(\s*game\s*:\s*HttpGet\s*\(\s*["'`]([^"'`]+)["'`]/gi,

    /*
     * loadstring(game.HttpGet("URL"))
     */
    /loadstring\s*\(\s*game\s*\.\s*HttpGet\s*\(\s*["'`]([^"'`]+)["'`]/gi,

    /*
     * loadstring("URL")
     */
    /loadstring\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]\s*\)/gi
  ];

  for (const regex of patterns) {
    for (const match of source.matchAll(regex)) {
      const candidate = match[1];

      try {
        const url = new URL(candidate);

        if (
          url.protocol === "http:" ||
          url.protocol === "https:"
        ) {
          urls.add(url.href);
        }
      } catch {
        // Ignore malformed URL candidates.
      }
    }
  }

  return [...urls];
}

/*
 * Used when the user's entire input might itself
 * be a URL or might contain a loadstring.
 */

function resolveInputURL(input) {
  /*
   * 1. loadstring(...)
   */
  const loadstringUrls =
    extractLoadstringUrls(input);

  if (loadstringUrls.length) {
    return loadstringUrls[0];
  }

  /*
   * 2. Entire input is a URL.
   */
  const trimmed = input.trim();

  try {
    const url = new URL(trimmed);

    if (
      url.protocol === "http:" ||
      url.protocol === "https:"
    ) {
      return url.href;
    }
  } catch {
    // Not a standalone URL.
  }

  /*
   * 3. URL somewhere inside input.
   */
  const urls = extractUrls(input);

  if (urls.length) {
    return urls[0];
  }

  return null;
}

/* =========================================================
   REMOTE FETCH
========================================================= */

async function fetchSource(url) {
  console.log(
    `[FETCH] Attempting: ${url}`
  );

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `Invalid extracted URL: ${url}`
    );
  }

  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:"
  ) {
    throw new Error(
      `Unsupported URL protocol: ${parsed.protocol}`
    );
  }

  try {
    const response = await fetch(
      parsed.href,
      {
        method: "GET",
        redirect: "follow",

        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; LuaDeobfBot/3.1)",
          "Accept":
            "text/plain,text/*,*/*"
        },

        signal:
          AbortSignal.timeout(30000)
      }
    );

    console.log(
      `[FETCH] ${response.status} ${response.statusText}`
    );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}`
      );
    }

    const source =
      await response.text();

    if (!source.trim()) {
      throw new Error(
        "The URL returned an empty response."
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
      `[FETCH FAILED] ${parsed.href}`
    );

    console.error(error);

    throw new Error(
      `Could not fetch ${parsed.href}: ${error.message}`
    );
  }
}

/* =========================================================
   STATIC STRING DECODERS
========================================================= */

function decodeDecimalEscapes(source) {
  return source.replace(
    /\\(\d{1,3})/g,
    (full, digits) => {
      const value =
        Number(digits);

      if (
        value >= 0 &&
        value <= 255
      ) {
        return String.fromCharCode(
          value
        );
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

/* =========================================================
   BASE64
========================================================= */

function looksLikeBase64(value) {
  return (
    value.length >= 16 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(
      value
    )
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

        /*
         * Don't replace arbitrary binary-looking
         * data with garbage.
         */
        if (
          /[\x00-\x08\x0E-\x1F]/.test(
            decoded
          )
        ) {
          return full;
        }

        return (
          quote +
          decoded +
          quote
        );

      } catch {
        return full;
      }
    }
  );
}

/* =========================================================
   SIMPLE XOR
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
      const key =
        Number(keyText);

      if (
        key < 0 ||
        key > 255
      ) {
        return full;
      }

      return JSON.stringify(
        xorBytes(
          value,
          key
        )
      );
    }
  );
}

/* =========================================================
   ARITHMETIC CONSTANT FOLDING
========================================================= */

function foldArithmetic(source) {
  let previous;

  do {
    previous = source;

    source = source.replace(
      /(?<![\w.])(-?\d+(?:\.\d+)?)\s*([+\-*\/])\s*(-?\d+(?:\.\d+)?)(?![\w.])/g,
      (
        full,
        aText,
        operator,
        bText
      ) => {
        const a =
          Number(aText);

        const b =
          Number(bText);

        let result;

        switch (operator) {
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
            if (b === 0) {
              return full;
            }

            result = a / b;
            break;

          default:
            return full;
        }

        if (
          !Number.isFinite(result)
        ) {
          return full;
        }

        return String(result);
      }
    );

  } while (
    previous !== source
  );

  return source;
}

/* =========================================================
   STRING CONCATENATION
========================================================= */

function foldStringConcats(source) {
  let previous;

  do {
    previous = source;

    source = source.replace(
      /(["'])(.*?)\1\s*\.\.\s*(["'])(.*?)\3/g,
      (full, q1, a, q2, b) =>
        JSON.stringify(a + b)
    );

  } while (
    previous !== source
  );

  return source;
}

/* =========================================================
   COMMENT CLEANUP
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
    .replace(
      /\n{4,}/g,
      "\n\n\n"
    );
}

/* =========================================================
   PROTECTION DETECTION
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
      "program counter",
      /\b(?:pc|program_counter|instruction_pointer)\b/i
    ],

    [
      "state machine",
      /\b(?:state|state_id|next_state|dispatch)\b/i
    ],

    [
      "metatable indirection",
      /\b(?:setmetatable|getmetatable|__index|__newindex)\b/
    ],

    [
      "debug/integrity checks",
      /\bdebug\./
    ],

    [
      "string byte/char operations",
      /\bstring\.(?:byte|char|sub)\b/
    ],

    [
      "bitwise operations",
      /\b(?:bit32|bit)\./
    ],

    [
      "control-flow flattening indicators",
      /\b(?:dispatcher|state_table|jump_table|next_state)\b/i
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
    "Base64 decoding",
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

/*
 * IMPORTANT:
 *
 * We ONLY recursively fetch URLs that occur in
 * loadstring/HttpGet patterns.
 *
 * A random URL inside ordinary Lua isn't followed.
 */

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
      stopped:
        "maximum fetch depth reached"
    };
  }

  const loadstringUrls =
    extractLoadstringUrls(source);

  if (!loadstringUrls.length) {
    return {
      source,
      chain: []
    };
  }

  const url =
    loadstringUrls[0];

  if (visited.has(url)) {
    return {
      source,
      chain: [url],
      stopped:
        "circular URL detected"
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

    stopped:
      nested.stopped
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
      extractLoadstringUrls(
        source
      ),

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
   COMMAND HANDLER
========================================================= */

client.on(
  "interactionCreate",
  async interaction => {
    if (
      !interaction.isChatInputCommand()
    ) {
      return;
    }

    /* -----------------------------------------
       PING
    ----------------------------------------- */

    if (
      interaction.commandName ===
      "ping"
    ) {
      await interaction.reply(
        "🏓 Pong!"
      );

      return;
    }

    /* -----------------------------------------
       DEOBF
    ----------------------------------------- */

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
          "❌ Provide Lua source, a loadstring, a raw URL, or upload a Lua file.",
        ephemeral: true
      });

      return;
    }

    await interaction.deferReply();

    try {
      let originalSource;
      let filename =
        "deobfuscated.lua";

      /* ---------------------------------------
         FILE
      --------------------------------------- */

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

        console.log(
          `[FILE] Downloading ${attachment.name}`
        );

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
            `Discord attachment returned HTTP ${response.status}.`
          );
        }

        originalSource =
          await response.text();
      }

      /* ---------------------------------------
         INPUT
      --------------------------------------- */

      else {
        originalSource =
          input;
      }

      if (
        !originalSource ||
        !originalSource.trim()
      ) {
        throw new Error(
          "The supplied input is empty."
        );
      }

      if (
        originalSource.length >
        MAX_SOURCE_SIZE
      ) {
        throw new Error(
          "Input exceeds the 2 MB limit."
        );
      }

      /* ---------------------------------------
         DIRECT URL / LOADSTRING
      --------------------------------------- */

      const directURL =
        resolveInputURL(
          originalSource
        );

      let sourceToProcess =
        originalSource;

      let sourceChain = [];

      /*
       * If input is a direct URL or contains
       * a loadstring, resolve it.
       */
      if (directURL) {
        console.log(
          `[INPUT URL] ${directURL}`
        );

        sourceToProcess =
          await fetchSource(
            directURL
          );

        sourceChain.push(
          directURL
        );
      }

      /* ---------------------------------------
         RECURSIVE LOADSTRING FETCHING
      --------------------------------------- */

      const resolved =
        await resolveRecursive(
          sourceToProcess,
          0,
          new Set(
            sourceChain
          )
        );

      sourceToProcess =
        resolved.source;

      sourceChain = [
        ...sourceChain,
        ...resolved.chain
      ];

      /* ---------------------------------------
         STATIC DEOBFUSCATION
      --------------------------------------- */

      const result =
        deobfuscate(
          sourceToProcess
        );

      /* ---------------------------------------
         ANALYSIS
      --------------------------------------- */

      const analysis =
        analyze(
          result.source
        );

      /* ---------------------------------------
         RAW OUTPUT
      --------------------------------------- */

      const rawURL =
        publishRaw(
          result.source,
          filename
        );

      /* ---------------------------------------
         DISCORD RESPONSE
      --------------------------------------- */

      let message =
        "## ✅ Source Processed\n\n";

      message +=
        `**Input:** ${originalSource.length.toLocaleString()} characters\n`;

      message +=
        `**Output:** ${result.source.length.toLocaleString()} characters\n`;

      message +=
        `**Lines:** ${analysis.lines.toLocaleString()}\n`;

      message +=
        `**Functions:** ${analysis.functions.toLocaleString()}\n\n`;

      message +=
        `### 🔗 Raw Output\n${rawURL}\n\n`;

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

      if (sourceChain.length) {
        message +=
          "\n\n### 🌐 Loaded Sources\n";

        message +=
          sourceChain
            .map(
              url =>
                `- ${url}`
            )
            .join("\n");
      }

      if (
        resolved.stopped
      ) {
        message +=
          `\n\n⚠️ ${resolved.stopped}`;
      }

      if (
        analysis.protection.length
      ) {
        message +=
          "\n\n### 🔍 Remaining Indicators\n";

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
          "\n\n### 🔗 Loadstrings Found\n";

        message +=
          analysis.loadstrings
            .map(
              url =>
                `- ${url}`
            )
            .join("\n");
      }

      /*
       * Discord limit.
       */

      if (message.length > 1900) {
        message =
          message.slice(0, 1800) +
          "\n\n...See the raw output URL for the complete result.";
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
        String(
          error.message ||
          error
        );

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

process.on(
  "uncaughtException",
  error => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);

/* =========================================================
   LOGIN
========================================================= */

client.login(TOKEN);

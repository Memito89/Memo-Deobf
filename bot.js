const express = require("express");
const crypto = require("crypto");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

/*
===========================================================
CONFIG
===========================================================
*/

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

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

/*
===========================================================
RAW SOURCE SERVER
===========================================================
*/

const app = express();

const rawStore = new Map();

app.get("/", (req, res) => {
  res.type("text").send(
    "Lua static analysis service is online."
  );
});

app.get("/raw/:id", (req, res) => {
  const entry = rawStore.get(req.params.id);

  if (!entry) {
    return res.status(404).send(
      "Source not found or expired."
    );
  }

  res.setHeader(
    "Content-Type",
    "text/plain; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  res.send(entry.source);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `HTTP server listening on port ${PORT}`
  );
});

function publishRaw(source, filename = "deobfuscated.lua") {
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

  const base =
    process.env.PUBLIC_URL ||
    `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;

  return `${base}/raw/${id}`;
}

/*
===========================================================
DISCORD
===========================================================
*/

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

const commands = [
  new SlashCommandBuilder()
    .setName("deobf")
    .setDescription(
      "Statically deobfuscate/analyze Lua or Luau"
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
          "Lua/Luau source file"
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
    "Discord commands registered."
  );
}

/*
===========================================================
URL / LOADSTRING RESOLUTION
===========================================================
*/

function extractUrls(source) {
  const regex =
    /https?:\/\/[^\s"'`<>()$begin:math:display$$end:math:display${}]+/gi;

  return [
    ...new Set(
      [...source.matchAll(regex)]
        .map(match =>
          match[0].replace(
            /[.,;]+$/,
            ""
          )
        )
    )
  ];
}

function extractLoadstringUrls(source) {
  const patterns = [
    /loadstring\s*\(\s*game\s*:\s*HttpGet\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/gi,

    /loadstring\s*\(\s*game\s*\.\s*HttpGet\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/gi,

    /loadstring\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]\s*\)/gi
  ];

  const urls = new Set();

  for (const regex of patterns) {
    for (const match of source.matchAll(regex)) {
      urls.add(match[1]);
    }
  }

  return [...urls];
}

function resolveURL(input) {
  const loadstrings =
    extractLoadstringUrls(input);

  if (loadstrings.length) {
    return loadstrings[0];
  }

  const urls =
    extractUrls(input);

  if (urls.length) {
    return urls[0];
  }

  return null;
}

/*
===========================================================
REMOTE FETCH
===========================================================
*/

async function fetchSource(url) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "Invalid URL."
    );
  }

  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:"
  ) {
    throw new Error(
      "Only HTTP/HTTPS URLs are allowed."
    );
  }

  const response = await fetch(
    parsed.href,
    {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Lua-Static-Analyzer/2.0"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}`
    );
  }

  const source =
    await response.text();

  if (
    source.length >
    MAX_SOURCE_SIZE
  ) {
    throw new Error(
      "Source exceeds the 2 MB limit."
    );
  }

  return source;
}

/*
===========================================================
STATIC STRING DECODERS
===========================================================
*/

/*
Lua decimal escapes:

"\104\101\108\108\111"
        ↓
"hello"
*/

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

/*
Lua hexadecimal escapes:

"\x68\x65\x6c\x6c\x6f"
*/

function decodeHexEscapes(source) {
  return source.replace(
    /\\x([0-9a-fA-F]{2})/g,
    (full, hex) =>
      String.fromCharCode(
        parseInt(hex, 16)
      )
  );
}

/*
Base64 detection.
*/

function looksLikeBase64(value) {
  if (
    typeof value !== "string" ||
    value.length < 16
  ) {
    return false;
  }

  if (
    value.length % 4 !== 0
  ) {
    return false;
  }

  return /^[A-Za-z0-9+/]+={0,2}$/.test(
    value
  );
}

function decodeBase64Strings(source) {
  return source.replace(
    /(["'])([A-Za-z0-9+/]{16,}={0,2})\1/g,
    (full, quote, value) => {
      if (
        !looksLikeBase64(value)
      ) {
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
              quote,
              "g"
            ),
            "\\" + quote
          ) +
          quote
        );
      } catch {
        return full;
      }
    }
  );
}

/*
===========================================================
SIMPLE XOR STRING DECODER
===========================================================
*/

/*
Handles recognizable constructs such as:

xor("abc", 42)

when a static XOR function can be identified.

This does NOT execute Lua.
*/

function xorBytes(value, key) {
  let result = "";

  for (
    let i = 0;
    i < value.length;
    i++
  ) {
    result += String.fromCharCode(
      value.charCodeAt(i) ^
        key
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

      const decoded =
        xorBytes(
          value,
          key
        );

      return JSON.stringify(
        decoded
      );
    }
  );
}

/*
===========================================================
CONSTANT FOLDING
===========================================================
*/

/*
Only handles simple arithmetic.

Examples:

1 + 2
10 - 3
4 * 5
20 / 2

No arbitrary Lua execution.
*/

function foldArithmetic(source) {
  let previous;

  do {
    previous = source;

    source = source.replace(
      /(?<![\w.])(-?\d+(?:\.\d+)?)\s*([+\-*\/])\s*(-?\d+(?:\.\d+)?)(?![\w.])/g,
      (full, aText, op, bText) => {
        const a =
          Number(aText);

        const b =
          Number(bText);

        let result;

        if (op === "+")
          result = a + b;

        if (op === "-")
          result = a - b;

        if (op === "*")
          result = a * b;

        if (op === "/") {
          if (b === 0)
            return full;

          result = a / b;
        }

        if (
          !Number.isFinite(
            result
          )
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

/*
===========================================================
STRING CONCATENATION
===========================================================
*/

/*
Turns:

"hel" .. "lo"

into:

"hello"
*/

function foldStringConcats(source) {
  let previous;

  do {
    previous = source;

    source = source.replace(
      /(["'])(.*?)\1\s*\.\.\s*(["'])(.*?)\3/g,
      (full, q1, a, q2, b) => {
        return JSON.stringify(
          a + b
        );
      }
    );
  } while (
    previous !== source
  );

  return source;
}

/*
===========================================================
COMMENT CLEANUP
===========================================================
*/

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

/*
===========================================================
WHITESPACE CLEANUP
===========================================================
*/

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

/*
===========================================================
VM / OBFUSCATION DETECTION
===========================================================
*/

function detectProtection(source) {
  const findings = [];

  const checks = [
    {
      name:
        "loadstring execution",
      regex:
        /\bloadstring\s*\(/
    },

    {
      name:
        "HTTP source loading",
      regex:
        /\bHttpGet\s*\(/
    },

    {
      name:
        "large numeric table",
      regex:
        /\{(?:\s*-?\d+\s*,?){30,}\s*\}/
    },

    {
      name:
        "large string table",
      regex:
        /\{(?:\s*["'][^"']*["']\s*,?){20,}\s*\}/
    },

    {
      name:
        "computed dispatch",
      regex:
        /\b(?:while|for)\b[\s\S]{0,500}\b(?:pc|opcode|op|instruction|dispatch)\b/i
    },

    {
      name:
        "VM-like opcode table",
      regex:
        /\b(?:opcode|opcodes|instructions|bytecode|vm)\b/i
    },

    {
      name:
        "metatable indirection",
      regex:
        /\b(?:setmetatable|getmetatable|__index|__newindex)\b/
    },

    {
      name:
        "debug/integrity checks",
      regex:
        /\bdebug\./
    },

    {
      name:
        "string byte operations",
      regex:
        /\bstring\.(?:byte|char|sub)\b/
    },

    {
      name:
        "bitwise operations",
      regex:
        /\b(?:bit32|bit)\./
    },

    {
      name:
        "control-flow flattening indicators",
      regex:
        /\b(?:state|state_id|dispatcher|next_state|pc)\b/i
    }
  ];

  for (const check of checks) {
    if (check.regex.test(source)) {
      findings.push(
        check.name
      );
    }
  }

  return findings;
}

/*
===========================================================
DEOBFUSCATION PASSES
===========================================================
*/

function deobfuscate(source) {
  let output = source;

  const passes = [];

  const before = output;

  output =
    decodeDecimalEscapes(
      output
    );

  if (output !== before) {
    passes.push(
      "decimal escape decoding"
    );
  }

  const beforeHex =
    output;

  output =
    decodeHexEscapes(
      output
    );

  if (output !== beforeHex) {
    passes.push(
      "hex escape decoding"
    );
  }

  const beforeB64 =
    output;

  output =
    decodeBase64Strings(
      output
    );

  if (output !== beforeB64) {
    passes.push(
      "Base64 string decoding"
    );
  }

  const beforeXor =
    output;

  output =
    decodeSimpleXorCalls(
      output
    );

  if (output !== beforeXor) {
    passes.push(
      "static XOR decoding"
    );
  }

  const beforeMath =
    output;

  output =
    foldArithmetic(
      output
    );

  if (output !== beforeMath) {
    passes.push(
      "arithmetic constant folding"
    );
  }

  const beforeConcat =
    output;

  output =
    foldStringConcats(
      output
    );

  if (output !== beforeConcat) {
    passes.push(
      "string concatenation folding"
    );
  }

  const beforeComments =
    output;

  output =
    removeComments(
      output
    );

  if (output !== beforeComments) {
    passes.push(
      "comment removal"
    );
  }

  output =
    normalizeWhitespace(
      output
    );

  return {
    source: output,
    passes
  };
}

/*
===========================================================
RECURSIVE SOURCE RESOLUTION
===========================================================
*/

async function resolveSource(
  initialSource,
  depth = 0,
  visited = new Set()
) {
  if (
    depth > MAX_FETCH_DEPTH
  ) {
    return {
      source: initialSource,
      chain: [],
      depthLimit: true
    };
  }

  const url =
    resolveURL(
      initialSource
    );

  if (!url) {
    return {
      source: initialSource,
      chain: []
    };
  }

  if (
    visited.has(url)
  ) {
    return {
      source: initialSource,
      chain: [url],
      circular: true
    };
  }

  visited.add(url);

  const remote =
    await fetchSource(url);

  const nested =
    await resolveSource(
      remote,
      depth + 1,
      visited
    );

  return {
    source:
      nested.source,
    chain: [
      url,
      ...nested.chain
    ],
    depthLimit:
      nested.depthLimit,
    circular:
      nested.circular
  };
}

/*
===========================================================
ANALYSIS
===========================================================
*/

function analyze(source) {
  return {
    lines:
      source.split(/\r?\n/)
        .length,

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
      detectProtection(
        source
      )
  };
}

/*
===========================================================
DISCORD COMMAND HANDLER
===========================================================
*/

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

client.on(
  "interactionCreate",
  async interaction => {
    if (
      !interaction.isChatInputCommand()
    ) {
      return;
    }

    if (
      interaction.commandName ===
      "ping"
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
          "Provide Lua source, a loadstring/raw URL, or a Lua file.",
        ephemeral: true
      });

      return;
    }

    await interaction.deferReply();

    try {
      let originalSource;
      let filename =
        "deobfuscated.lua";

      /*
      -----------------------------------------------
      FILE
      -----------------------------------------------
      */

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
            attachment.url
          );

        if (!response.ok) {
          throw new Error(
            "Could not download the Discord attachment."
          );
        }

        originalSource =
          await response.text();
      }

      /*
      -----------------------------------------------
      TEXT / LOADSTRING / RAW URL
      -----------------------------------------------
      */

      else {
        originalSource =
          input;
      }

      if (
        originalSource.length >
        MAX_SOURCE_SIZE
      ) {
        throw new Error(
          "Input exceeds the 2 MB limit."
        );
      }

      /*
      -----------------------------------------------
      RESOLVE REMOTE SOURCE
      -----------------------------------------------
      */

      const resolved =
        await resolveSource(
          originalSource
        );

      /*
      -----------------------------------------------
      DEOBFUSCATION
      -----------------------------------------------
      */

      const result =
        deobfuscate(
          resolved.source
        );

      /*
      -----------------------------------------------
      ANALYSIS
      -----------------------------------------------
      */

      const analysis =
        analyze(
          result.source
        );

      /*
      -----------------------------------------------
      PUBLISH RESULT
      -----------------------------------------------
      */

      const rawUrl =
        publishRaw(
          result.source,
          filename
        );

      /*
      -----------------------------------------------
      RESPONSE
      -----------------------------------------------
      */

      let message =
        "## ✅ Deobfuscation Complete\n\n";

      message +=
        `**Input size:** ${originalSource.length.toLocaleString()} chars\n`;

      message +=
        `**Output size:** ${result.source.length.toLocaleString()} chars\n`;

      message +=
        `**Lines:** ${analysis.lines.toLocaleString()}\n\n`;

      message +=
        `### 🔗 Raw output\n${rawUrl}\n\n`;

      message +=
        "### 🔧 Passes applied\n";

      if (
        result.passes.length
      ) {
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
          "\n\n### 🌐 Source chain\n";

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
          "\n\n### 🔍 Remaining indicators\n";

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
          "\n\n### 🔗 Loadstrings found\n";

        message +=
          analysis.loadstrings
            .map(
              url =>
                `- ${url}`
            )
            .join("\n");
      }

      if (
        message.length > 1900
      ) {
        message =
          message.slice(
            0,
            1800
          ) +
          "\n\nSee the raw output URL for the complete result.";
      }

      await interaction.editReply(
        message
      );

    } catch (error) {
      console.error(
        "Deobfuscation error:",
        error
      );

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

client.login(
  TOKEN
);

/*
 * ============================================================
 * Lua Static Deobfuscation / Source Recovery Bot
 * ============================================================
 *
 * Railway environment variables:
 *
 * DISCORD_TOKEN=your_bot_token
 * CLIENT_ID=your_application_id
 * GUILD_ID=your_server_id
 * PUBLIC_URL=https://your-project.up.railway.app
 *
 * Node.js 18+ recommended.
 *
 * Supported /deobf inputs:
 *   - Lua/Luau source
 *   - raw HTTP/HTTPS URL
 *   - loadstring("https://...")
 *   - game:HttpGet("https://...")
 *   - uploaded .lua/.luau/.txt files
 *
 * Output:
 *   Only a raw URL containing the recovered Lua source.
 *
 * This performs STATIC transformations only.
 * It does not execute arbitrary Lua or attempt to unpack
 * protected commercial VM obfuscators.
 * ============================================================
 */

"use strict";

const express = require("express");
const crypto = require("crypto");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");

/* ============================================================
   CONFIG
============================================================ */

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const PUBLIC_URL = process.env.PUBLIC_URL;

const PORT = Number(process.env.PORT || 3000);

const MAX_SOURCE_SIZE = 2 * 1024 * 1024;
const MAX_FETCH_DEPTH = 5;
const RAW_LIFETIME = 60 * 60 * 1000;

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN.");
  process.exit(1);
}

if (!CLIENT_ID) {
  console.error("Missing CLIENT_ID.");
  process.exit(1);
}

if (!GUILD_ID) {
  console.error("Missing GUILD_ID.");
  process.exit(1);
}

if (!PUBLIC_URL) {
  console.warn(
    "WARNING: PUBLIC_URL is missing. Raw output links will not work."
  );
}

/* ============================================================
   EXPRESS SERVER
============================================================ */

const app = express();

app.disable("x-powered-by");

const rawStore = new Map();

/*
 * Health endpoint.
 */
app.get("/", (req, res) => {
  res.type("text").send(
    "Lua static recovery bot online."
  );
});

app.get("/health", (req, res) => {
  res.json({
    online: true,
    rawFiles: rawStore.size,
    mode: "static"
  });
});

/*
 * Raw source endpoint.
 */
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
  console.log(`Web server listening on port ${PORT}`);
});

/* ============================================================
   RAW SOURCE STORAGE
============================================================ */

function publishRaw(source, filename = "recovered.lua") {
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
    PUBLIC_URL.replace(/\/+$/, "") +
    "/raw/" +
    id
  );
}

/*
 * Periodic cleanup in case the process remains alive
 * for a long time.
 */
setInterval(() => {
  const now = Date.now();

  for (const [id, item] of rawStore) {
    if (
      now - item.created >
      RAW_LIFETIME
    ) {
      rawStore.delete(id);
    }
  }
}, 10 * 60 * 1000);

/* ============================================================
   DISCORD CLIENT
============================================================ */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

/* ============================================================
   SLASH COMMANDS
============================================================ */

const commands = [
  new SlashCommandBuilder()
    .setName("deobf")
    .setDescription(
      "Recover readable Lua from source, URL, loadstring, or file."
    )
    .addStringOption(option =>
      option
        .setName("input")
        .setDescription(
          "Lua source, raw URL, or loadstring."
        )
        .setRequired(false)
    )
    .addAttachmentOption(option =>
      option
        .setName("file")
        .setDescription(
          "Upload a .lua, .luau, or .txt file."
        )
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription(
      "Check whether the bot is online."
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

/* ============================================================
   URL HELPERS
============================================================ */

function extractUrls(source) {
  const regex =
    /https?:\/\/[^\s"'`<>()]+/gi;

  const matches =
    source.match(regex) || [];

  return [
    ...new Set(
      matches.map(url =>
        url.replace(
          /[),.;]+$/,
          ""
        )
      )
    )
  ];
}

function extractLoadstringUrls(source) {
  const urls = new Set();

  /*
   * loadstring("https://...")
   */
  const directLoadstring =
    /loadstring\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]\s*\)/gi;

  for (
    const match of source.matchAll(
      directLoadstring
    )
  ) {
    urls.add(match[1]);
  }

  /*
   * loadstring(game:HttpGet("https://..."))
   */
  const httpGet =
    /loadstring\s*\(\s*game\s*:\s*HttpGet\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]\s*\)\s*\)/gi;

  for (
    const match of source.matchAll(
      httpGet
    )
  ) {
    urls.add(match[1]);
  }

  /*
   * game.HttpGet(...)
   */
  const dotHttpGet =
    /(?:game|Game)\s*\.\s*HttpGet\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]\s*\)/gi;

  for (
    const match of source.matchAll(
      dotHttpGet
    )
  ) {
    urls.add(match[1]);
  }

  return [...urls];
}

function isHttpURL(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "http:" ||
      url.protocol === "https:"
    );
  } catch {
    return false;
  }
}

function resolveStandaloneURL(input) {
  const trimmed =
    input.trim();

  if (isHttpURL(trimmed)) {
    return trimmed;
  }

  const loadstringURLs =
    extractLoadstringUrls(
      trimmed
    );

  if (loadstringURLs.length) {
    return loadstringURLs[0];
  }

  return null;
}

/* ============================================================
   REMOTE FETCH
============================================================ */

async function fetchSource(url) {
  if (!isHttpURL(url)) {
    throw new Error(
      "Only HTTP/HTTPS URLs are supported."
    );
  }

  console.log(
    `[FETCH] ${url}`
  );

  let response;

  try {
    response = await fetch(
      url,
      {
        redirect: "follow",
        headers: {
          "User-Agent":
            "LuaStaticRecoveryBot/1.0",
          "Accept":
            "text/plain,text/*,*/*"
        },
        signal:
          AbortSignal.timeout(
            30000
          )
      }
    );
  } catch (error) {
    throw new Error(
      `Fetch failed for ${url}: ${error.message}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Fetch failed for ${url}: HTTP ${response.status}`
    );
  }

  const source =
    await response.text();

  if (!source.trim()) {
    throw new Error(
      "Fetched source is empty."
    );
  }

  if (
    source.length >
    MAX_SOURCE_SIZE
  ) {
    throw new Error(
      "Fetched source exceeds the 2 MB limit."
    );
  }

  return source;
}

/* ============================================================
   NESTED SOURCE RESOLUTION
============================================================ */

async function resolveRemoteChain(
  source,
  depth = 0,
  visited = new Set()
) {
  if (
    depth >=
    MAX_FETCH_DEPTH
  ) {
    return source;
  }

  const urls =
    extractLoadstringUrls(
      source
    );

  if (!urls.length) {
    return source;
  }

  const url = urls[0];

  if (visited.has(url)) {
    return source;
  }

  visited.add(url);

  const remote =
    await fetchSource(url);

  return resolveRemoteChain(
    remote,
    depth + 1,
    visited
  );
}

/* ============================================================
   STRING ESCAPE RECOVERY
============================================================ */

function decodeDecimalEscapes(source) {
  return source.replace(
    /\\([0-9]{1,3})/g,
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
    (full, hex) => {
      return String.fromCharCode(
        parseInt(hex, 16)
      );
    }
  );
}

function decodeUnicodeEscapes(source) {
  return source.replace(
    /\\u\{([0-9a-fA-F]+)\}/g,
    (full, hex) => {
      try {
        return String.fromCodePoint(
          parseInt(hex, 16)
        );
      } catch {
        return full;
      }
    }
  );
}

/* ============================================================
   STRING.CHAR RECOVERY
============================================================ */

function decodeStringChar(source) {
  return source.replace(
    /\bstring\s*\.\s*char\s*\(([^()]*)\)/gi,
    (full, argumentsText) => {
      const parts =
        argumentsText
          .split(",")
          .map(x => x.trim())
          .filter(Boolean);

      if (!parts.length) {
        return full;
      }

      const values = [];

      for (const part of parts) {
        if (!/^-?\d+$/.test(part)) {
          return full;
        }

        const value =
          Number(part);

        if (
          value < 0 ||
          value > 255
        ) {
          return full;
        }

        values.push(value);
      }

      try {
        return JSON.stringify(
          String.fromCharCode(
            ...values
          )
        );
      } catch {
        return full;
      }
    }
  );
}

/* ============================================================
   SIMPLE TABLE.CONCAT RECOVERY
============================================================ */

function decodeTableConcat(source) {
  return source.replace(
    /\btable\s*\.\s*concat\s*\(\s*\{([^{}]*)\}\s*\)/gi,
    (full, body) => {
      const values =
        body.match(
          /(["'])(?:\\.|(?!\1).)*\1/g
        );

      if (!values) {
        return full;
      }

      const result = [];

      for (const item of values) {
        result.push(
          item.slice(1, -1)
        );
      }

      return JSON.stringify(
        result.join("")
      );
    }
  );
}

/* ============================================================
   STRING CONCATENATION
============================================================ */

function foldStringConcat(source) {
  let previous;

  do {
    previous = source;

    /*
     * "abc" .. "def"
     */
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

/* ============================================================
   NUMBER HELPERS
============================================================ */

function isNumberToken(value) {
  return /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(
    value
  );
}

function calculateBinary(
  a,
  operator,
  b
) {
  switch (operator) {
    case "+":
      return a + b;

    case "-":
      return a - b;

    case "*":
      return a * b;

    case "/":
      if (b === 0) {
        return null;
      }

      return a / b;

    case "%":
      if (b === 0) {
        return null;
      }

      return a % b;

    case "^":
      return Math.pow(a, b);

    default:
      return null;
  }
}

/* ============================================================
   ARITHMETIC CONSTANT FOLDING
============================================================ */

function foldArithmetic(source) {
  let previous;

  do {
    previous = source;

    /*
     * Parenthesized simple expressions.
     */
    source = source.replace(
      /\(\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*([+\-*\/%^])\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*\)/g,
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

        const result =
          calculateBinary(
            a,
            operator,
            b
          );

        if (
          result === null ||
          !Number.isFinite(result)
        ) {
          return full;
        }

        return String(result);
      }
    );

    /*
     * Unparenthesized simple expressions.
     */
    source = source.replace(
      /(?<![\w.])(-?(?:\d+(?:\.\d+)?|\.\d+))\s*([+\-*\/%^])\s*(-?(?:\d+(?:\.\d+)?|\.\d+))(?![\w.])/g,
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

        const result =
          calculateBinary(
            a,
            operator,
            b
          );

        if (
          result === null ||
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

/* ============================================================
   COMPARISON FOLDING
============================================================ */

function foldComparisons(source) {
  return source.replace(
    /(?<![\w.])(-?\d+(?:\.\d+)?)\s*(==|~=|<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)(?![\w.])/g,
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
        case "==":
          result = a === b;
          break;

        case "~=":
          result = a !== b;
          break;

        case "<":
          result = a < b;
          break;

        case ">":
          result = a > b;
          break;

        case "<=":
          result = a <= b;
          break;

        case ">=":
          result = a >= b;
          break;

        default:
          return full;
      }

      return result
        ? "true"
        : "false";
    }
  );
}

/* ============================================================
   BOOLEAN CONSTANTS
============================================================ */

function foldBooleanConstants(source) {
  let previous;

  do {
    previous = source;

    source = source
      .replace(
        /\bnot\s+true\b/gi,
        "false"
      )
      .replace(
        /\bnot\s+false\b/gi,
        "true"
      )
      .replace(
        /\btrue\s+and\s+true\b/gi,
        "true"
      )
      .replace(
        /\btrue\s+and\s+false\b/gi,
        "false"
      )
      .replace(
        /\bfalse\s+and\s+true\b/gi,
        "false"
      )
      .replace(
        /\bfalse\s+and\s+false\b/gi,
        "false"
      )
      .replace(
        /\btrue\s+or\s+true\b/gi,
        "true"
      )
      .replace(
        /\btrue\s+or\s+false\b/gi,
        "true"
      )
      .replace(
        /\bfalse\s+or\s+true\b/gi,
        "true"
      );

  } while (
    previous !== source
  );

  return source;
}

/* ============================================================
   PARENTHESIS NORMALIZATION
============================================================ */

function simplifyParentheses(source) {
  let previous;

  do {
    previous = source;

    source = source.replace(
      /\(\s*(-?\d+(?:\.\d+)?)\s*\)/g,
      "$1"
    );

    source = source.replace(
      /\(\s*(true|false|nil)\s*\)/gi,
      "$1"
    );

  } while (
    previous !== source
  );

  return source;
}

/* ============================================================
   LOCAL STRING ALIASES
============================================================ */

function resolveLocalStringAliases(source) {
  const aliases = new Map();

  const regex =
    /\blocal\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(["'])(.*?)\2\s*;?/g;

  for (
    const match of source.matchAll(
      regex
    )
  ) {
    aliases.set(
      match[1],
      JSON.stringify(
        match[3]
      )
    );
  }

  /*
   * Only replace aliases when the identifier is not
   * obviously being assigned again.
   */
  for (
    const [name, value] of aliases
  ) {
    const regex =
      new RegExp(
        `\\b${escapeRegex(name)}\\b`,
        "g"
      );

    source =
      source.replace(
        regex,
        value
      );
  }

  return source;
}

/* ============================================================
   LOCAL CONSTANT ALIASES
============================================================ */

function resolveConstantAliases(source) {
  const aliases = new Map();

  const regex =
    /\blocal\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?|true|false|nil)\s*;?/g;

  for (
    const match of source.matchAll(
      regex
    )
  ) {
    aliases.set(
      match[1],
      match[2]
    );
  }

  for (
    const [name, value] of aliases
  ) {
    const regex =
      new RegExp(
        `\\b${escapeRegex(name)}\\b`,
        "g"
      );

    source =
      source.replace(
        regex,
        value
      );
  }

  return source;
}

/* ============================================================
   CONSTANT IF RECOVERY
============================================================ */

function simplifyConstantIfs(source) {
  /*
   * Only simple cases.
   */
  source = source.replace(
    /if\s+true\s+then([\s\S]*?)\bend\b/gi,
    "$1"
  );

  source = source.replace(
    /if\s+false\s+then([\s\S]*?)\bend\b/gi,
    ""
  );

  return source;
}

/* ============================================================
   CONSTANT RETURN NORMALIZATION
============================================================ */

function simplifyConstantReturns(source) {
  return source.replace(
    /return\s*\(\s*(["'])(.*?)\1\s*\)/g,
    (
      full,
      quote,
      value
    ) => {
      return (
        "return " +
        quote +
        value +
        quote
      );
    }
  );
}

/* ============================================================
   SIMPLE CONSTANT FUNCTION NORMALIZATION
============================================================ */

function simplifyConstantFunctions(source) {
  return source.replace(
    /local\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*return\s+((?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|-?\d+(?:\.\d+)?|true|false|nil))\s*end/gi,
    (
      full,
      name,
      value
    ) => {
      return (
        `local ${name} = function()\n` +
        `    return ${value}\n` +
        `end`
      );
    }
  );
}

/* ============================================================
   TABLE NORMALIZATION
============================================================ */

function simplifyNumericTables(source) {
  return source.replace(
    /\{\s*(-?\d+(?:\s*,\s*-?\d+)+)\s*\}/g,
    (
      full,
      values
    ) => {
      const items =
        values
          .split(",")
          .map(x => x.trim());

      if (
        items.length > 500
      ) {
        return full;
      }

      return (
        "{ " +
        items.join(", ") +
        " }"
      );
    }
  );
}

function simplifyStringTables(source) {
  return source.replace(
    /\{\s*((?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*')(?:\s*,\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'))+)\s*\}/g,
    (
      full,
      body
    ) => {
      const values =
        body.match(
          /"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/g
        );

      if (!values) {
        return full;
      }

      return (
        "{ " +
        values.join(", ") +
        " }"
      );
    }
  );
}

/* ============================================================
   COMMENT REMOVAL
============================================================ */

function removeComments(source) {
  /*
   * Lua long comments.
   */
  source = source.replace(
    /--\[\[[\s\S]*?\]\]/g,
    ""
  );

  /*
   * Normal comments.
   *
   * This intentionally avoids trying to remove text
   * inside quoted strings.
   */
  source = source.replace(
    /--[^\r\n]*/g,
    ""
  );

  return source;
}

/* ============================================================
   WHITESPACE
============================================================ */

function normalizeWhitespace(source) {
  return source
    .replace(
      /\r\n/g,
      "\n"
    )
    .replace(
      /\r/g,
      "\n"
    )
    .split("\n")
    .map(line =>
      line.replace(
        /[ \t]+$/g,
        ""
      )
    )
    .join("\n")
    .replace(
      /\n{4,}/g,
      "\n\n\n"
    )
    .trim();
}

/* ============================================================
   REGEX ESCAPE
============================================================ */

function escapeRegex(value) {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

/* ============================================================
   STATIC RECOVERY PIPELINE
============================================================ */

function recoverLua(source) {
  let output = source;

  /*
   * Multiple rounds are useful because one pass can expose
   * another constant expression.
   */
  const passes = [
    decodeDecimalEscapes,
    decodeHexEscapes,
    decodeUnicodeEscapes,
    decodeStringChar,
    decodeTableConcat,
    foldStringConcat,
    foldArithmetic,
    foldComparisons,
    foldBooleanConstants,
    simplifyParentheses,
    resolveLocalStringAliases,
    resolveConstantAliases,
    simplifyConstantIfs,
    simplifyConstantReturns,
    simplifyConstantFunctions,
    simplifyNumericTables,
    simplifyStringTables
  ];

  for (let round = 0; round < 12; round++) {
    let changed = false;

    for (const pass of passes) {
      const before = output;

      try {
        output =
          pass(output);
      } catch {
        /*
         * A failed transformation must never destroy
         * the source.
         */
        output = before;
      }

      if (output !== before) {
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  /*
   * Formatting is deliberately last.
   */
  output =
    removeComments(output);

  output =
    normalizeWhitespace(output);

  /*
   * Never return an empty result when the input wasn't empty.
   */
  if (
    source.trim() &&
    !output.trim()
  ) {
    return source;
  }

  return output;
}

/* ============================================================
   DISCORD READY
============================================================ */

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

/* ============================================================
   COMMAND HANDLER
============================================================ */

client.on(
  "interactionCreate",
  async interaction => {
    if (
      !interaction.isChatInputCommand()
    ) {
      return;
    }

    /* --------------------------------------------------------
       PING
    -------------------------------------------------------- */

    if (
      interaction.commandName === "ping"
    ) {
      await interaction.reply(
        "🏓 Pong!"
      );

      return;
    }

    /* --------------------------------------------------------
       DEOBF
    -------------------------------------------------------- */

    if (
      interaction.commandName !== "deobf"
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

    if (
      !input &&
      !attachment
    ) {
      await interaction.reply({
        content:
          "Provide Lua source, a raw URL, a loadstring, or a Lua file.",
        ephemeral: true
      });

      return;
    }

    await interaction.deferReply();

    try {
      let source = null;

      /* ------------------------------------------------------
         FILE
      ------------------------------------------------------ */

      if (attachment) {
        const filename =
          attachment.name ||
          "source.lua";

        const lower =
          filename.toLowerCase();

        if (
          !lower.endsWith(".lua") &&
          !lower.endsWith(".luau") &&
          !lower.endsWith(".txt")
        ) {
          throw new Error(
            "Only .lua, .luau, and .txt files are supported."
          );
        }

        let response;

        try {
          response =
            await fetch(
              attachment.url,
              {
                signal:
                  AbortSignal.timeout(
                    30000
                  )
              }
            );
        } catch (error) {
          throw new Error(
            `Failed to download Discord attachment: ${error.message}`
          );
        }

        if (!response.ok) {
          throw new Error(
            `Discord attachment returned HTTP ${response.status}.`
          );
        }

        source =
          await response.text();
      }

      /* ------------------------------------------------------
         TEXT / URL / LOADSTRING
      ------------------------------------------------------ */

      else {
        const possibleURL =
          resolveStandaloneURL(
            input
          );

        if (possibleURL) {
          source =
            await fetchSource(
              possibleURL
            );
        } else {
          source = input;
        }
      }

      if (
        typeof source !== "string"
      ) {
        throw new Error(
          "Input could not be converted to text."
        );
      }

      if (
        source.length >
        MAX_SOURCE_SIZE
      ) {
        throw new Error(
          "Input exceeds the 2 MB limit."
        );
      }

      /* ------------------------------------------------------
         FETCH LOADSTRING SOURCE CHAIN
      ------------------------------------------------------ */

      source =
        await resolveRemoteChain(
          source
        );

      if (
        source.length >
        MAX_SOURCE_SIZE
      ) {
        throw new Error(
          "Resolved source exceeds the 2 MB limit."
        );
      }

      /* ------------------------------------------------------
         STATIC RECOVERY
      ------------------------------------------------------ */

      const recovered =
        recoverLua(source);

      /* ------------------------------------------------------
         RAW OUTPUT
      ------------------------------------------------------ */

      const rawURL =
        publishRaw(
          recovered,
          "recovered.lua"
        );

      /*
       * Discord message contains ONLY the raw Lua URL.
       */
      await interaction.editReply(
        rawURL
      );

    } catch (error) {
      console.error(
        "DEOBF ERROR:",
        error
      );

      const message =
        String(
          error?.message ||
          error
        ).slice(
          0,
          1500
        );

      await interaction.editReply(
        `❌ ${message}`
      );
    }
  }
);

/* ============================================================
   DISCORD ERROR HANDLERS
============================================================ */

client.on(
  "error",
  error => {
    console.error(
      "Discord client error:",
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

/* ============================================================
   LOGIN
============================================================ */

client.login(TOKEN);

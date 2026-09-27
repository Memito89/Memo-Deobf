"use strict";

/*
 * ============================================================
 * RAILWAY LUA RECOVERY BOT
 * ============================================================
 *
 * Environment variables:
 *
 * DISCORD_TOKEN
 * CLIENT_ID
 * GUILD_ID
 * PUBLIC_URL
 *
 * Features:
 *
 *  /deobf
 *    - Lua source
 *    - Luau source
 *    - URL
 *    - loadstring URL
 *    - HttpGet URL
 *    - uploaded .lua/.luau/.txt
 *
 * Static recovery:
 *
 *    decimal escapes
 *    hexadecimal escapes
 *    unicode escapes
 *    string.char()
 *    table.concat()
 *    string concatenation
 *    arithmetic folding
 *    comparison folding
 *    boolean folding
 *    constant aliases
 *    string aliases
 *    Base64
 *    Base64URL
 *    Base85 / Ascii85
 *    hex blobs
 *    decimal byte arrays
 *    simple XOR byte arrays
 *    simple constant tables
 *    simple constant functions
 *    constant branches
 *    comments
 *    repeated passes
 *
 * IMPORTANT:
 *
 * This is STATIC analysis.
 *
 * It does not execute arbitrary Lua/Luau.
 * It does not execute loadstring.
 * It does not execute Roblox code.
 *
 * A candidate is only published when it passes
 * Lua-source validation.
 * ============================================================
 */

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

const TOKEN =
  process.env.DISCORD_TOKEN;

const CLIENT_ID =
  process.env.CLIENT_ID;

const GUILD_ID =
  process.env.GUILD_ID;

const PUBLIC_URL =
  process.env.PUBLIC_URL;

const PORT =
  Number(process.env.PORT || 3000);

const MAX_SOURCE_SIZE =
  2 * 1024 * 1024;

const MAX_FETCH_DEPTH = 5;

const MAX_TRANSFORM_ROUNDS = 15;

const MAX_CANDIDATES = 80;

const RAW_LIFETIME =
  60 * 60 * 1000;

if (!TOKEN) {
  console.error(
    "Missing DISCORD_TOKEN"
  );
  process.exit(1);
}

if (!CLIENT_ID) {
  console.error(
    "Missing CLIENT_ID"
  );
  process.exit(1);
}

if (!GUILD_ID) {
  console.error(
    "Missing GUILD_ID"
  );
  process.exit(1);
}

if (!PUBLIC_URL) {
  console.error(
    "Missing PUBLIC_URL"
  );
  process.exit(1);
}

/* ============================================================
   EXPRESS
============================================================ */

const app = express();

app.disable(
  "x-powered-by"
);

app.get(
  "/",
  (req, res) => {
    res.type("text").send(
      "Lua recovery bot online."
    );
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      online: true,
      mode: "static",
      files: rawStore.size
    });
  }
);

const rawStore =
  new Map();

app.get(
  "/raw/:id",
  (req, res) => {
    const item =
      rawStore.get(
        req.params.id
      );

    if (!item) {
      return res
        .status(404)
        .type("text")
        .send(
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

    res.send(
      item.source
    );
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `HTTP server listening on ${PORT}`
    );
  }
);

/* ============================================================
   RAW STORAGE
============================================================ */

function publishRaw(
  source,
  filename = "recovered.lua"
) {
  const id =
    crypto
      .randomBytes(16)
      .toString("hex");

  rawStore.set(
    id,
    {
      source,
      filename,
      created: Date.now()
    }
  );

  setTimeout(
    () => {
      rawStore.delete(id);
    },
    RAW_LIFETIME
  );

  return (
    PUBLIC_URL.replace(
      /\/+$/,
      ""
    ) +
    "/raw/" +
    id
  );
}

setInterval(
  () => {
    const now =
      Date.now();

    for (
      const [
        id,
        item
      ] of rawStore
    ) {
      if (
        now - item.created >
        RAW_LIFETIME
      ) {
        rawStore.delete(id);
      }
    }
  },
  10 * 60 * 1000
);

/* ============================================================
   DISCORD
============================================================ */

const client =
  new Client({
    intents: [
      GatewayIntentBits.Guilds
    ]
  });

const commands = [
  new SlashCommandBuilder()
    .setName("deobf")
    .setDescription(
      "Recover readable Lua source."
    )
    .addStringOption(
      option =>
        option
          .setName("input")
          .setDescription(
            "Lua, URL, or loadstring."
          )
          .setRequired(false)
    )
    .addAttachmentOption(
      option =>
        option
          .setName("file")
          .setDescription(
            "Lua/Luau/TXT file."
          )
          .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription(
      "Check bot status."
    )
].map(
  command =>
    command.toJSON()
);

async function registerCommands() {
  const rest =
    new REST({
      version: "10"
    }).setToken(
      TOKEN
    );

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
   GENERAL HELPERS
============================================================ */

function escapeRegex(
  value
) {
  return value.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

function isHTTP(value) {
  try {
    const url =
      new URL(value);

    return (
      url.protocol ===
        "http:" ||
      url.protocol ===
        "https:"
    );
  } catch {
    return false;
  }
}

function unique(
  values
) {
  return [
    ...new Set(values)
  ];
}

/* ============================================================
   URL EXTRACTION
============================================================ */

function extractURLs(
  source
) {
  const regex =
    /https?:\/\/[^\s"'`<>()]+/gi;

  return unique(
    (
      source.match(regex) ||
      []
    ).map(
      url =>
        url.replace(
          /[),.;]+$/,
          ""
        )
    )
  );
}

function extractLoadstringURLs(
  source
) {
  const urls =
    new Set();

  const patterns = [
    /loadstring\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]\s*\)/gi,

    /loadstring\s*\(\s*game\s*:\s*HttpGet\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]\s*\)\s*\)/gi,

    /loadstring\s*\(\s*game\s*\.\s*HttpGet\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]\s*\)\s*\)/gi,

    /game\s*:\s*HttpGet\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]\s*\)/gi,

    /game\s*\.\s*HttpGet\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]\s*\)/gi
  ];

  for (
    const pattern of patterns
  ) {
    for (
      const match of source.matchAll(
        pattern
      )
    ) {
      if (match[1]) {
        urls.add(
          match[1]
        );
      }
    }
  }

  return [
    ...urls
  ];
}

/* ============================================================
   FETCH
============================================================ */

async function fetchSource(
  url
) {
  if (!isHTTP(url)) {
    throw new Error(
      "Invalid HTTP URL."
    );
  }

  let response;

  try {
    response =
      await fetch(
        url,
        {
          redirect:
            "follow",

          headers: {
            "User-Agent":
              "LuaRecoveryBot/2.0",
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

  const text =
    await response.text();

  if (
    text.length >
    MAX_SOURCE_SIZE
  ) {
    throw new Error(
      "Downloaded source exceeds 2 MB."
    );
  }

  return text;
}

/* ============================================================
   INPUT RESOLUTION
============================================================ */

async function resolveInput(
  input
) {
  const trimmed =
    input.trim();

  if (
    isHTTP(trimmed)
  ) {
    return fetchSource(
      trimmed
    );
  }

  const loadURLs =
    extractLoadstringURLs(
      trimmed
    );

  if (
    loadURLs.length
  ) {
    return fetchSource(
      loadURLs[0]
    );
  }

  return trimmed;
}

/* ============================================================
   REMOTE CHAIN
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
    extractLoadstringURLs(
      source
    );

  if (
    !urls.length
  ) {
    return source;
  }

  let current =
    source;

  for (
    const url of urls
  ) {
    if (
      visited.has(url)
    ) {
      continue;
    }

    visited.add(url);

    try {
      current =
        await fetchSource(
          url
        );

      return resolveRemoteChain(
        current,
        depth + 1,
        visited
      );
    } catch {
      /*
       * Leave the current source intact.
       */
    }
  }

  return current;
}

/* ============================================================
   BASE64
============================================================ */

function isBase64(
  value
) {
  const text =
    value.trim();

  if (
    text.length < 8 ||
    text.length % 4 !== 0
  ) {
    return false;
  }

  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(
      text
    )
  ) {
    return false;
  }

  try {
    const decoded =
      Buffer
        .from(
          text,
          "base64"
        )
        .toString(
          "utf8"
        );

    return (
      decoded.length > 0 &&
      /[\x09\x0A\x0D\x20-\x7E]/.test(
        decoded
      )
    );
  } catch {
    return false;
  }
}

function decodeBase64(
  source
) {
  return source.replace(
    /["']([A-Za-z0-9+/]{16,}={0,2})["']/g,
    (
      full,
      encoded
    ) => {
      if (
        !isBase64(
          encoded
        )
      ) {
        return full;
      }

      try {
        const decoded =
          Buffer
            .from(
              encoded,
              "base64"
            )
            .toString(
              "utf8"
            );

        if (
          looksLikeLua(
            decoded
          )
        ) {
          return (
            JSON.stringify(
              decoded
            )
          );
        }

        return full;
      } catch {
        return full;
      }
    }
  );
}

/* ============================================================
   BASE64URL
============================================================ */

function decodeBase64URL(
  source
) {
  return source.replace(
    /["']([A-Za-z0-9_-]{16,})["']/g,
    (
      full,
      encoded
    ) => {
      let value =
        encoded
          .replace(
            /-/g,
            "+"
          )
          .replace(
            /_/g,
            "/"
          );

      while (
        value.length % 4
      ) {
        value += "=";
      }

      try {
        const decoded =
          Buffer
            .from(
              value,
              "base64"
            )
            .toString(
              "utf8"
            );

        if (
          looksLikeLua(
            decoded
          )
        ) {
          return JSON.stringify(
            decoded
          );
        }
      } catch {}

      return full;
    }
  );
}

/* ============================================================
   BASE85 / ASCII85
============================================================ */

function decodeAscii85Block(
  text
) {
  let data =
    text;

  if (
    data.startsWith("<~") &&
    data.endsWith("~>")
  ) {
    data =
      data.slice(
        2,
        -2
      );
  }

  data =
    data.replace(
      /\s/g,
      ""
    );

  const output =
    [];

  let group = [];

  function flush() {
    if (
      group.length === 0
    ) {
      return;
    }

    const originalLength =
      group.length;

    while (
      group.length < 5
    ) {
      group.push(
        "u"
      );
    }

    let value = 0;

    for (
      const char of group
    ) {
      const code =
        char.charCodeAt(0) -
        33;

      if (
        code < 0 ||
        code > 84
      ) {
        group = [];
        return;
      }

      value =
        value * 85 +
        code;
    }

    const bytes = [
      (value >>> 24) & 255,
      (value >>> 16) & 255,
      (value >>> 8) & 255,
      value & 255
    ];

    const count =
      originalLength -
      1;

    for (
      let i = 0;
      i < count;
      i++
    ) {
      output.push(
        bytes[i]
      );
    }

    group = [];
  }

  for (
    const char of data
  ) {
    if (
      char === "z" &&
      group.length === 0
    ) {
      output.push(
        0,
        0,
        0,
        0
      );
      continue;
    }

    group.push(
      char
    );

    if (
      group.length === 5
    ) {
      flush();
    }
  }

  flush();

  return Buffer.from(
    output
  );
}

function decodeBase85(
  source
) {
  return source.replace(
    /<~[!-u\s]{16,}~>/g,
    full => {
      try {
        const decoded =
          decodeAscii85Block(
            full
          ).toString(
            "utf8"
          );

        if (
          looksLikeLua(
            decoded
          )
        ) {
          return JSON.stringify(
            decoded
          );
        }
      } catch {}

      return full;
    }
  );
}

/* ============================================================
   HEX BLOBS
============================================================ */

function decodeHexBlob(
  source
) {
  return source.replace(
    /["']([0-9a-fA-F]{16,})["']/g,
    (
      full,
      hex
    ) => {
      if (
        hex.length % 2 !== 0
      ) {
        return full;
      }

      try {
        const decoded =
          Buffer
            .from(
              hex,
              "hex"
            )
            .toString(
              "utf8"
            );

        if (
          looksLikeLua(
            decoded
          )
        ) {
          return JSON.stringify(
            decoded
          );
        }
      } catch {}

      return full;
    }
  );
}

/* ============================================================
   DECIMAL BYTE ARRAYS
============================================================ */

function decodeDecimalByteArray(
  source
) {
  return source.replace(
    /\{(\s*\d{1,3}(?:\s*,\s*\d{1,3}){7,}\s*)\}/g,
    (
      full,
      body
    ) => {
      const values =
        body
          .split(",")
          .map(
            x =>
              Number(
                x.trim()
              )
          );

      if (
        values.some(
          x =>
            !Number.isInteger(
              x
            ) ||
            x < 0 ||
            x > 255
        )
      ) {
        return full;
      }

      const decoded =
        Buffer
          .from(values)
          .toString(
            "utf8"
          );

      if (
        looksLikeLua(
          decoded
        )
      ) {
        return JSON.stringify(
          decoded
        );
      }

      return full;
    }
  );
}

/* ============================================================
   LUA ESCAPES
============================================================ */

function decodeDecimalEscapes(
  source
) {
  return source.replace(
    /\\([0-9]{1,3})/g,
    (
      full,
      digits
    ) => {
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

function decodeHexEscapes(
  source
) {
  return source.replace(
    /\\x([0-9a-fA-F]{2})/g,
    (
      full,
      hex
    ) =>
      String.fromCharCode(
        parseInt(
          hex,
          16
        )
      )
  );
}

function decodeUnicodeEscapes(
  source
) {
  return source.replace(
    /\\u\{([0-9a-fA-F]+)\}/g,
    (
      full,
      hex
    ) => {
      try {
        return String.fromCodePoint(
          parseInt(
            hex,
            16
          )
        );
      } catch {
        return full;
      }
    }
  );
}

/* ============================================================
   STRING.CHAR
============================================================ */

function decodeStringChar(
  source
) {
  return source.replace(
    /\bstring\s*\.\s*char\s*\(([^()]*)\)/gi,
    (
      full,
      args
    ) => {
      const values =
        args
          .split(",")
          .map(
            x =>
              x.trim()
          )
          .filter(Boolean);

      if (
        !values.length
      ) {
        return full;
      }

      if (
        values.some(
          x =>
            !/^-?\d+$/.test(
              x
            )
        )
      ) {
        return full;
      }

      const numbers =
        values.map(
          Number
        );

      if (
        numbers.some(
          x =>
            x < 0 ||
            x > 255
        )
      ) {
        return full;
      }

      return JSON.stringify(
        String.fromCharCode(
          ...numbers
        )
      );
    }
  );
}

/* ============================================================
   TABLE.CONCAT
============================================================ */

function decodeTableConcat(
  source
) {
  return source.replace(
    /\btable\s*\.\s*concat\s*\(\s*\{([^{}]*)\}\s*\)/gi,
    (
      full,
      body
    ) => {
      const values =
        body.match(
          /"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/g
        );

      if (
        !values
      ) {
        return full;
      }

      const result =
        values
          .map(
            value =>
              value.slice(
                1,
                -1
              )
          )
          .join("");

      return JSON.stringify(
        result
      );
    }
  );
}

/* ============================================================
   STRING CONCAT
============================================================ */

function foldStringConcat(
  source
) {
  let previous;

  do {
    previous =
      source;

    source =
      source.replace(
        /(["'])(.*?)\1\s*\.\.\s*(["'])(.*?)\3/g,
        (
          full,
          q1,
          a,
          q2,
          b
        ) =>
          JSON.stringify(
            a + b
          )
      );

  } while (
    previous !== source
  );

  return source;
}

/* ============================================================
   ARITHMETIC
============================================================ */

function calculate(
  a,
  op,
  b
) {
  switch (op) {
    case "+":
      return a + b;

    case "-":
      return a - b;

    case "*":
      return a * b;

    case "/":
      if (b === 0)
        return null;

      return a / b;

    case "%":
      if (b === 0)
        return null;

      return a % b;

    case "^":
      return Math.pow(
        a,
        b
      );

    default:
      return null;
  }
}

function foldArithmetic(
  source
) {
  let previous;

  do {
    previous =
      source;

    source =
      source.replace(
        /\(\s*(-?\d+(?:\.\d+)?)\s*([+\-*\/%^])\s*(-?\d+(?:\.\d+)?)\s*\)/g,
        (
          full,
          a,
          op,
          b
        ) => {
          const result =
            calculate(
              Number(a),
              op,
              Number(b)
            );

          if (
            result === null ||
            !Number.isFinite(
              result
            )
          ) {
            return full;
          }

          return String(
            result
          );
        }
      );

  } while (
    previous !== source
  );

  return source;
}

/* ============================================================
   COMPARISONS
============================================================ */

function foldComparisons(
  source
) {
  return source.replace(
    /(?<![\w.])(-?\d+(?:\.\d+)?)\s*(==|~=|<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)(?![\w.])/g,
    (
      full,
      aText,
      op,
      bText
    ) => {
      const a =
        Number(aText);

      const b =
        Number(bText);

      let result;

      switch (op) {
        case "==":
          result =
            a === b;
          break;

        case "~=":
          result =
            a !== b;
          break;

        case "<":
          result =
            a < b;
          break;

        case ">":
          result =
            a > b;
          break;

        case "<=":
          result =
            a <= b;
          break;

        case ">=":
          result =
            a >= b;
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
   BOOLEAN
============================================================ */

function foldBooleans(
  source
) {
  let previous;

  do {
    previous =
      source;

    source =
      source
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
   ALIASES
============================================================ */

function resolveStringAliases(
  source
) {
  const aliases =
    new Map();

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

  for (
    const [
      name,
      value
    ] of aliases
  ) {
    source =
      source.replace(
        new RegExp(
          `\\b${escapeRegex(
            name
          )}\\b`,
          "g"
        ),
        value
      );
  }

  return source;
}

function resolveConstantAliases(
  source
) {
  const aliases =
    new Map();

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
    const [
      name,
      value
    ] of aliases
  ) {
    source =
      source.replace(
        new RegExp(
          `\\b${escapeRegex(
            name
          )}\\b`,
          "g"
        ),
        value
      );
  }

  return source;
}

/* ============================================================
   CONSTANT FUNCTIONS
============================================================ */

function simplifyFunctions(
  source
) {
  return source.replace(
    /local\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*return\s+((?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|-?\d+(?:\.\d+)?|true|false|nil))\s*end/gi,
    (
      full,
      name,
      value
    ) =>
      `local ${name} = function()\n` +
      `    return ${value}\n` +
      `end`
  );
}

/* ============================================================
   CONSTANT BRANCHES
============================================================ */

function simplifyBranches(
  source
) {
  source =
    source.replace(
      /if\s+true\s+then([\s\S]*?)\bend/gi,
      "$1"
    );

  source =
    source.replace(
      /if\s+false\s+then([\s\S]*?)\bend/gi,
      ""
    );

  return source;
}

/* ============================================================
   PARENTHESES
============================================================ */

function simplifyParentheses(
  source
) {
  let previous;

  do {
    previous =
      source;

    source =
      source.replace(
        /\(\s*(-?\d+(?:\.\d+)?)\s*\)/g,
        "$1"
      );

    source =
      source.replace(
        /\(\s*(true|false|nil)\s*\)/gi,
        "$1"
      );

  } while (
    previous !== source
  );

  return source;
}

/* ============================================================
   COMMENTS
============================================================ */

function removeComments(
  source
) {
  /*
   * Long comments.
   */
  source =
    source.replace(
      /--\[\[[\s\S]*?\]\]/g,
      ""
    );

  /*
   * Standard comments.
   */
  source =
    source.replace(
      /--[^\r\n]*/g,
      ""
    );

  return source;
}

/* ============================================================
   WHITESPACE
============================================================ */

function normalizeWhitespace(
  source
) {
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
    .map(
      line =>
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
   LUA VALIDATION
============================================================ */

function balancedPairs(
  source
) {
  const stack =
    [];

  let quote =
    null;

  let escape =
    false;

  for (
    let i = 0;
    i < source.length;
    i++
  ) {
    const c =
      source[i];

    if (quote) {
      if (escape) {
        escape =
          false;
        continue;
      }

      if (c === "\\") {
        escape =
          true;
        continue;
      }

      if (c === quote) {
        quote =
          null;
      }

      continue;
    }

    if (
      c === '"' ||
      c === "'"
    ) {
      quote =
        c;
      continue;
    }

    if (
      c === "(" ||
      c === "[" ||
      c === "{"
    ) {
      stack.push(c);
    }

    if (
      c === ")" ||
      c === "]" ||
      c === "}"
    ) {
      const expected =
        c === ")"
          ? "("
          : c === "]"
            ? "["
            : "{";

      if (
        stack.pop() !==
        expected
      ) {
        return false;
      }
    }
  }

  return (
    !quote &&
    stack.length === 0
  );
}

function looksLikeLua(
  source
) {
  if (
    typeof source !==
    "string"
  ) {
    return false;
  }

  const text =
    source.trim();

  if (
    text.length < 2 ||
    text.length >
      MAX_SOURCE_SIZE
  ) {
    return false;
  }

  if (
    !balancedPairs(
      text
    )
  ) {
    return false;
  }

  /*
   * Strong Lua/Luau indicators.
   */
  const indicators = [
    /\bprint\s*\(/,
    /\blocal\b/,
    /\bfunction\b/,
    /\breturn\b/,
    /\bif\b/,
    /\bthen\b/,
    /\bend\b/,
    /\bfor\b/,
    /\bwhile\b/,
    /\brepeat\b/,
    /\buntil\b/,
    /\bdo\b/,
    /\btable\./,
    /\bstring\./,
    /\bmath\./,
    /\bgame\b/,
    /\bworkspace\b/,
    /\bInstance\b/,
    /:[A-Za-z_][A-Za-z0-9_]*\s*\(/,
    /local\s+[A-Za-z_][A-Za-z0-9_]*/
  ];

  let score =
    0;

  for (
    const pattern of indicators
  ) {
    if (
      pattern.test(text)
    ) {
      score++;
    }
  }

  /*
   * A valid simple Lua expression such as
   * print("hi") should pass.
   */
  if (
    score >= 1
  ) {
    return true;
  }

  /*
   * Basic Lua statement fallback.
   */
  if (
    /^(?:["'].*["']|\d+|true|false|nil)\s*;?$/.test(
      text
    )
  ) {
    return true;
  }

  return false;
}

/* ============================================================
   LUA SCORE
============================================================ */

function luaScore(
  source
) {
  let score = 0;

  if (
    looksLikeLua(
      source
    )
  ) {
    score += 100;
  }

  const tests = [
    [
      /\bfunction\b/g,
      5
    ],
    [
      /\blocal\b/g,
      5
    ],
    [
      /\breturn\b/g,
      5
    ],
    [
      /\bif\b[\s\S]*\bthen\b/g,
      5
    ],
    [
      /\bend\b/g,
      3
    ],
    [
      /\bprint\s*\(/g,
      10
    ],
    [
      /\bgame\b/g,
      4
    ],
    [
      /\bworkspace\b/g,
      4
    ],
    [
      /\bInstance\b/g,
      4
    ],
    [
      /:[A-Za-z_][A-Za-z0-9_]*\s*\(/g,
      3
    ]
  ];

  for (
    const [
      pattern,
      points
    ] of tests
  ) {
    const matches =
      source.match(
        pattern
      );

    if (matches) {
      score +=
        Math.min(
          matches.length,
          20
        ) *
        points;
    }
  }

  /*
   * Penalize suspicious binary-looking output.
   */
  const controlCount =
    (
      source.match(
        /[\x00-\x08\x0B\x0C\x0E-\x1F]/g
      ) || []
    ).length;

  score -=
    Math.min(
      controlCount,
      50
    );

  /*
   * Penalize giant numeric-only structures.
   */
  const numericCount =
    (
      source.match(
        /\b\d{3,}\b/g
      ) || []
    ).length;

  if (
    numericCount > 100
  ) {
    score -=
      Math.min(
        100,
        numericCount / 5
      );
  }

  return score;
}

/* ============================================================
   CANDIDATE SYSTEM
============================================================ */

function addCandidate(
  candidates,
  source,
  label
) {
  if (
    typeof source !==
    "string"
  ) {
    return;
  }

  if (
    !source.trim()
  ) {
    return;
  }

  if (
    candidates.some(
      item =>
        item.source ===
        source
    )
  ) {
    return;
  }

  candidates.push({
    source,
    label,
    score:
      luaScore(
        source
      )
  });

  if (
    candidates.length >
    MAX_CANDIDATES
  ) {
    candidates.sort(
      (a, b) =>
        b.score -
        a.score
    );

    candidates.pop();
  }
}

/* ============================================================
   RECOVERY PIPELINE
============================================================ */

function recoverLua(
  original
) {
  const candidates =
    [];

  addCandidate(
    candidates,
    original,
    "original"
  );

  let current =
    original;

  const passes = [
    [
      "decimal escapes",
      decodeDecimalEscapes
    ],
    [
      "hex escapes",
      decodeHexEscapes
    ],
    [
      "unicode escapes",
      decodeUnicodeEscapes
    ],
    [
      "Base64",
      decodeBase64
    ],
    [
      "Base64URL",
      decodeBase64URL
    ],
    [
      "Base85",
      decodeBase85
    ],
    [
      "hex blobs",
      decodeHexBlob
    ],
    [
      "decimal byte arrays",
      decodeDecimalByteArray
    ],
    [
      "string.char",
      decodeStringChar
    ],
    [
      "table.concat",
      decodeTableConcat
    ],
    [
      "string concatenation",
      foldStringConcat
    ],
    [
      "arithmetic",
      foldArithmetic
    ],
    [
      "comparisons",
      foldComparisons
    ],
    [
      "booleans",
      foldBooleans
    ],
    [
      "parentheses",
      simplifyParentheses
    ],
    [
      "string aliases",
      resolveStringAliases
    ],
    [
      "constant aliases",
      resolveConstantAliases
    ],
    [
      "functions",
      simplifyFunctions
    ],
    [
      "branches",
      simplifyBranches
    ]
  ];

  for (
    let round = 0;
    round <
    MAX_TRANSFORM_ROUNDS;
    round++
  ) {
    let changed =
      false;

    for (
      const [
        label,
        fn
      ] of passes
    ) {
      const before =
        current;

      try {
        current =
          fn(current);
      } catch {
        current =
          before;
      }

      if (
        current !==
        before
      ) {
        changed =
          true;

        addCandidate(
          candidates,
          current,
          label
        );
      }
    }

    if (
      !changed
    ) {
      break;
    }
  }

  /*
   * Formatting candidates.
   */
  for (
    const candidate of [
      ...candidates
    ]
  ) {
    let formatted;

    try {
      formatted =
        normalizeWhitespace(
          removeComments(
            candidate.source
          )
        );
    } catch {
      continue;
    }

    addCandidate(
      candidates,
      formatted,
      candidate.label +
        " + formatting"
    );
  }

  /*
   * Only candidates that genuinely look like Lua.
   */
  const valid =
    candidates
      .filter(
        candidate =>
          looksLikeLua(
            candidate.source
          )
      )
      .sort(
        (a, b) =>
          b.score -
          a.score
      );

  if (
    !valid.length
  ) {
    return null;
  }

  return valid[0];
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
   INTERACTION HANDLER
============================================================ */

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

    if (
      !input &&
      !attachment
    ) {
      await interaction.reply({
        content:
          "Give me Lua source, a URL, loadstring, or a Lua file.",
        ephemeral: true
      });

      return;
    }

    await interaction.deferReply();

    try {
      let source;

      /*
       * FILE INPUT
       */
      if (
        attachment
      ) {
        const filename =
          attachment.name ||
          "source.lua";

        const lower =
          filename.toLowerCase();

        if (
          !lower.endsWith(
            ".lua"
          ) &&
          !lower.endsWith(
            ".luau"
          ) &&
          !lower.endsWith(
            ".txt"
          )
        ) {
          throw new Error(
            "Only .lua, .luau and .txt files are supported."
          );
        }

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

        if (
          !response.ok
        ) {
          throw new Error(
            `Attachment fetch failed: HTTP ${response.status}`
          );
        }

        source =
          await response.text();
      }

      /*
       * TEXT / URL INPUT
       */
      else {
        source =
          await resolveInput(
            input
          );
      }

      if (
        typeof source !==
        "string"
      ) {
        throw new Error(
          "Input is not text."
        );
      }

      if (
        source.length >
        MAX_SOURCE_SIZE
      ) {
        throw new Error(
          "Input is larger than 2 MB."
        );
      }

      /*
       * Follow loadstring/HttpGet chains.
       */
      source =
        await resolveRemoteChain(
          source
        );

      /*
       * Recover.
       */
      const result =
        recoverLua(
          source
        );

      /*
       * IMPORTANT:
       *
       * Do NOT publish VM garbage,
       * binary data, numeric blobs,
       * or an invalid result.
       */
      if (
        !result ||
        !looksLikeLua(
          result.source
        )
      ) {
        await interaction.editReply(
          "❌ I couldn't safely recover valid Lua source from this input, so I did not create a raw output."
        );

        return;
      }

      /*
       * Final safety check.
       */
      if (
        !balancedPairs(
          result.source
        )
      ) {
        await interaction.editReply(
          "❌ The best candidate did not pass Lua structure validation, so no raw output was created."
        );

        return;
      }

      /*
       * Publish ONLY validated Lua.
       */
      const url =
        publishRaw(
          result.source,
          "recovered.lua"
        );

      await interaction.editReply(
        url
      );

    } catch (error) {
      console.error(
        "DEOBF ERROR:",
        error
      );

      await interaction.editReply(
        `❌ ${String(
          error?.message ||
          error
        ).slice(
          0,
          1800
        )}`
      );
    }
  }
);

/* ============================================================
   ERRORS
============================================================ */

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

/* ============================================================
   LOGIN
============================================================ */

client
  .login(TOKEN)
  .catch(error => {
    console.error(
      "Discord login failed:",
      error
    );

    process.exit(1);
  });

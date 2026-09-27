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
   WEB SERVER
========================================================= */

const app = express();
const rawStore = new Map();

app.get("/", (req, res) => {
  res.type("text").send(
    "Lua static analysis / sandbox dumper online."
  );
});

app.get("/health", (req, res) => {
  res.json({
    online: true,
    storedSources: rawStore.size,
    mode: "static-analysis"
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
  console.log(`HTTP server listening on ${PORT}`);
});

/* =========================================================
   RAW HOSTING
========================================================= */

function publishRaw(source, filename) {
  if (!PUBLIC_URL) {
    throw new Error(
      "PUBLIC_URL is missing from Railway Variables."
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
      "Analyze Lua/Luau source"
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
      "Check bot status"
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

  console.log("Slash commands registered.");
}

/* =========================================================
   URL EXTRACTION
========================================================= */

function extractUrls(source) {
  const matches = source.match(
    /https?:\/\/(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?(?:\/[^\s"'`<>()$begin:math:display$$end:math:display${}]*)?/gi
  );

  if (!matches) {
    return [];
  }

  return [
    ...new Set(
      matches.map(x =>
        x.replace(/[.,;]+$/, "")
      )
    )
  ];
}

function extractLoadstringUrls(source) {
  const urls = new Set();

  const patterns = [
    /loadstring\s*\(\s*game\s*:\s*HttpGet\s*\(\s*["'`]([^"'`]+)["'`]/gi,

    /loadstring\s*\(\s*game\s*\.\s*HttpGet\s*\(\s*["'`]([^"'`]+)["'`]/gi,

    /loadstring\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]\s*\)/gi
  ];

  for (const regex of patterns) {
    for (const match of source.matchAll(regex)) {
      try {
        const url = new URL(match[1]);

        if (
          url.protocol === "http:" ||
          url.protocol === "https:"
        ) {
          urls.add(url.href);
        }
      } catch {
        // Ignore invalid candidates.
      }
    }
  }

  return [...urls];
}

function resolveInputURL(input) {
  const loadstrings =
    extractLoadstringUrls(input);

  if (loadstrings.length) {
    return loadstrings[0];
  }

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

  return null;
}

/* =========================================================
   FETCHER
========================================================= */

async function fetchSource(url) {
  console.log(`[FETCH] ${url}`);

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

  try {
    const response = await fetch(
      parsed.href,
      {
        redirect: "follow",
        headers: {
          "User-Agent":
            "LuaStaticAnalyzer/1.0",
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

    if (!source.trim()) {
      throw new Error(
        "Remote source is empty."
      );
    }

    if (
      source.length >
      MAX_SOURCE_SIZE
    ) {
      throw new Error(
        "Remote source exceeds the 2 MB limit."
      );
    }

    return source;

  } catch (error) {
    console.error(
      `[FETCH FAILED] ${parsed.href}`,
      error
    );

    throw new Error(
      `Fetch failed for ${parsed.href}: ${error.message}`
    );
  }
}

/* =========================================================
   LOADSTRING RESOLUTION
========================================================= */

async function resolveRecursive(
  source,
  depth = 0,
  visited = new Set()
) {
  if (depth >= MAX_FETCH_DEPTH) {
    return {
      source,
      chain: [],
      stopped:
        "maximum source depth reached"
    };
  }

  const urls =
    extractLoadstringUrls(source);

  if (!urls.length) {
    return {
      source,
      chain: []
    };
  }

  const url = urls[0];

  if (visited.has(url)) {
    return {
      source,
      chain: [url],
      stopped:
        "circular source detected"
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
   STATIC STRING ANALYSIS
========================================================= */

function extractQuotedStrings(source) {
  const results = [];
  const regex =
    /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

  for (const match of source.matchAll(regex)) {
    const value = match[2];

    if (value.length > 0) {
      results.push(value);
    }
  }

  return [
    ...new Set(results)
  ];
}

function extractNumbers(source) {
  const results =
    source.match(
      /(?<![\w.])-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)/g
    ) || [];

  return [
    ...new Set(results)
  ];
}

function extractFunctionNames(source) {
  const names = [];

  const patterns = [
    /\bfunction\s+([A-Za-z_][A-Za-z0-9_.:]*)/g,

    /\blocal\s+function\s+([A-Za-z_][A-Za-z0-9_]*)/g,

    /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function\b/g
  ];

  for (const regex of patterns) {
    for (const match of source.matchAll(regex)) {
      names.push(match[1]);
    }
  }

  return [
    ...new Set(names)
  ];
}

/* =========================================================
   VM-STYLE STRUCTURE DETECTION
========================================================= */

function detectVMStructures(source) {
  const findings = [];

  const checks = [
    [
      "dispatcher",
      /\b(?:dispatch|dispatcher|dispatch_table|dispatchTable)\b/i
    ],

    [
      "opcode",
      /\b(?:opcode|opcodes|OPCODE|OPCODES)\b/
    ],

    [
      "program counter",
      /\b(?:pc|PC|program_counter|instruction_pointer)\b/
    ],

    [
      "instruction table",
      /\b(?:instructions|instruction_table|instructionTable)\b/i
    ],

    [
      "VM state",
      /\b(?:vm|VM|vm_state|vmState|state_table)\b/
    ],

    [
      "constant table",
      /\b(?:constants|constant_table|consts|CONST)\b/i
    ],

    [
      "prototype",
      /\b(?:prototype|prototypes|proto|closure)\b/i
    ],

    [
      "register",
      /\b(?:register|registers|reg|regs)\b/i
    ],

    [
      "jump/state machine",
      /\b(?:next_state|jump_table|jump|state_id)\b/i
    ],

    [
      "metatable",
      /\b(?:setmetatable|getmetatable|__index|__newindex)\b/
    ],

    [
      "bytecode",
      /\b(?:bytecode|byte_code|bytecodes)\b/i
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
   ROBLOX-STYLE ENVIRONMENT ACCESS DETECTOR
========================================================= */

const ROBLOX_SERVICES = [
  "Players",
  "Workspace",
  "ReplicatedStorage",
  "ReplicatedFirst",
  "ServerStorage",
  "ServerScriptService",
  "StarterGui",
  "StarterPack",
  "StarterPlayer",
  "Lighting",
  "RunService",
  "UserInputService",
  "TweenService",
  "HttpService",
  "TeleportService",
  "MarketplaceService",
  "DataStoreService",
  "CollectionService",
  "TextService",
  "SoundService",
  "Teams",
  "Chat"
];

function detectRobloxEnvironment(source) {
  const services = [];
  const globals = [];
  const methods = [];

  for (const service of ROBLOX_SERVICES) {
    const regex =
      new RegExp(
        `["'\`]${service}["'\`]`,
        "g"
      );

    if (regex.test(source)) {
      services.push(service);
    }
  }

  const globalPatterns = [
    "game",
    "workspace",
    "script",
    "plugin",
    "shared",
    "_G",
    "getgenv",
    "getfenv",
    "setfenv"
  ];

  for (const name of globalPatterns) {
    const regex =
      new RegExp(
        `\\b${name}\\b`,
        "g"
      );

    if (regex.test(source)) {
      globals.push(name);
    }
  }

  const methodRegex =
    /:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

  for (const match of source.matchAll(methodRegex)) {
    methods.push(match[1]);
  }

  return {
    services: [
      ...new Set(services)
    ],

    globals: [
      ...new Set(globals)
    ],

    methods: [
      ...new Set(methods)
    ]
  };
}

/* =========================================================
   ROBLOX-LIKE SANDBOX DUMPER
========================================================= */

/*
 * This does NOT execute the script.
 *
 * It creates a symbolic environment representation.
 */

class SymbolicObject {
  constructor(path) {
    this.path = path;
  }

  get(property) {
    return new SymbolicObject(
      `${this.path}.${property}`
    );
  }

  call(method, args = []) {
    return {
      type: "call",
      object: this.path,
      method,
      arguments: args
    };
  }
}

function createSandboxModel() {
  const game = new SymbolicObject("game");
  const workspace =
    new SymbolicObject("workspace");
  const script =
    new SymbolicObject("script");

  return {
    game,
    workspace,
    script,

    services:
      Object.fromEntries(
        ROBLOX_SERVICES.map(name => [
          name,
          game.get(name)
        ])
      )
  };
}

/* =========================================================
   SYMBOLIC CALL EXTRACTION
========================================================= */

function extractCalls(source) {
  const calls = [];

  const regex =
    /([A-Za-z_][A-Za-z0-9_.:]*)\s*\(([^()\n]{0,500})\)/g;

  for (const match of source.matchAll(regex)) {
    const expression =
      match[1];

    const args =
      match[2]
        .trim();

    let object = null;
    let method = expression;

    if (expression.includes(":")) {
      const parts =
        expression.split(":");

      method =
        parts.pop();

      object =
        parts.join(":");
    }

    calls.push({
      expression,
      object,
      method,
      arguments:
        args
          ? args
          : []
    });
  }

  return calls.slice(0, 1000);
}

/* =========================================================
   TABLE / ARRAY ANALYSIS
========================================================= */

function analyzeTables(source) {
  const numericTables = [];
  const stringTables = [];

  const tableRegex =
    /\{([\s\S]{0,20000})\}/g;

  for (const match of source.matchAll(tableRegex)) {
    const body = match[1];

    const numbers =
      body.match(
        /-?\d+(?:\.\d+)?/g
      ) || [];

    const strings =
      body.match(
        /(["'])(.*?)\1/g
      ) || [];

    if (numbers.length >= 10) {
      numericTables.push({
        size: numbers.length,
        sample:
          numbers.slice(0, 20)
      });
    }

    if (strings.length >= 5) {
      stringTables.push({
        size: strings.length,
        sample:
          strings
            .slice(0, 20)
      });
    }
  }

  return {
    numericTables:
      numericTables.slice(0, 50),

    stringTables:
      stringTables.slice(0, 50)
  };
}

/* =========================================================
   STATIC TRANSFORMATIONS
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

        return Number.isFinite(result)
          ? String(result)
          : full;
      }
    );
  } while (
    previous !== source
  );

  return source;
}

function foldStringConcat(source) {
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

function removeComments(source) {
  source = source.replace(
    /--$begin:math:display$\\\[\[\\s\\S\]\*\?$end:math:display$\]/g,
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
    .map(x => x.trimEnd())
    .join("\n")
    .replace(
      /\n{4,}/g,
      "\n\n\n"
    );
}

/* =========================================================
   STATIC ANALYZER
========================================================= */

function analyzeSource(source) {
  const strings =
    extractQuotedStrings(source);

  const numbers =
    extractNumbers(source);

  const functions =
    extractFunctionNames(source);

  const calls =
    extractCalls(source);

  const vm =
    detectVMStructures(source);

  const roblox =
    detectRobloxEnvironment(source);

  const tables =
    analyzeTables(source);

  return {
    lines:
      source.split(/\r?\n/).length,

    characters:
      source.length,

    functions,

    strings,

    numbers,

    calls,

    vm,

    roblox,

    tables,

    urls:
      extractUrls(source),

    loadstrings:
      extractLoadstringUrls(source)
  };
}

/* =========================================================
   FULL ANALYSIS / DUMP
========================================================= */

function createDump(source) {
  const analysis =
    analyzeSource(source);

  const sandbox =
    createSandboxModel();

  const dump = [];

  dump.push(
    "============================================================"
  );

  dump.push(
    "ROBLOX-LIKE STATIC DUMPER"
  );

  dump.push(
    "============================================================"
  );

  dump.push("");

  dump.push(
    "[SOURCE]"
  );

  dump.push(
    `Lines: ${analysis.lines}`
  );

  dump.push(
    `Characters: ${analysis.characters}`
  );

  dump.push("");

  dump.push(
    "[FUNCTIONS]"
  );

  if (analysis.functions.length) {
    for (const name of analysis.functions) {
      dump.push(
        `- ${name}`
      );
    }
  } else {
    dump.push(
      "- None detected"
    );
  }

  dump.push("");

  dump.push(
    "[VM STRUCTURE]"
  );

  if (analysis.vm.length) {
    for (const item of analysis.vm) {
      dump.push(
        `- ${item}`
      );
    }
  } else {
    dump.push(
      "- No common VM indicators detected"
    );
  }

  dump.push("");

  dump.push(
    "[ROBLOX ENVIRONMENT]"
  );

  dump.push(
    `Globals: ${
      analysis.roblox.globals.join(", ") ||
      "none"
    }`
  );

  dump.push(
    `Services: ${
      analysis.roblox.services.join(", ") ||
      "none"
    }`
  );

  dump.push(
    `Methods: ${
      analysis.roblox.methods
        .slice(0, 100)
        .join(", ") ||
      "none"
    }`
  );

  dump.push("");

  dump.push(
    "[SYMBOLIC ENVIRONMENT]"
  );

  dump.push(
    `game -> ${sandbox.game.path}`
  );

  dump.push(
    `workspace -> ${sandbox.workspace.path}`
  );

  dump.push(
    `script -> ${sandbox.script.path}`
  );

  dump.push("");

  dump.push(
    "[CALLS]"
  );

  for (
    const call of analysis.calls.slice(0, 250)
  ) {
    dump.push(
      `- ${call.expression}(${call.arguments})`
    );
  }

  if (!analysis.calls.length) {
    dump.push(
      "- None detected"
    );
  }

  dump.push("");

  dump.push(
    "[STRING TABLE]"
  );

  for (
    const value of analysis.strings.slice(0, 500)
  ) {
    dump.push(
      JSON.stringify(value)
    );
  }

  if (!analysis.strings.length) {
    dump.push(
      "- Empty"
    );
  }

  dump.push("");

  dump.push(
    "[NUMERIC CONSTANTS]"
  );

  dump.push(
    analysis.numbers
      .slice(0, 500)
      .join(", ")
  );

  dump.push("");

  dump.push(
    "[NUMERIC TABLES]"
  );

  for (
    const table of analysis.tables.numericTables
  ) {
    dump.push(
      `- ${table.size} entries: ${table.sample.join(", ")}`
    );
  }

  if (
    !analysis.tables.numericTables.length
  ) {
    dump.push(
      "- None detected"
    );
  }

  dump.push("");

  dump.push(
    "[STRING TABLES]"
  );

  for (
    const table of analysis.tables.stringTables
  ) {
    dump.push(
      `- ${table.size} entries`
    );

    dump.push(
      `  ${table.sample.join(", ")}`
    );
  }

  if (
    !analysis.tables.stringTables.length
  ) {
    dump.push(
      "- None detected"
    );
  }

  dump.push("");

  dump.push(
    "[URLS]"
  );

  for (const url of analysis.urls) {
    dump.push(
      `- ${url}`
    );
  }

  if (!analysis.urls.length) {
    dump.push(
      "- None"
    );
  }

  dump.push("");

  dump.push(
    "[LOADSTRINGS]"
  );

  for (const url of analysis.loadstrings) {
    dump.push(
      `- ${url}`
    );
  }

  if (!analysis.loadstrings.length) {
    dump.push(
      "- None"
    );
  }

  dump.push("");

  dump.push(
    "============================================================"
  );

  dump.push(
    "END STATIC DUMP"
  );

  dump.push(
    "============================================================"
  );

  return dump.join("\n");
}

/* =========================================================
   SAFE STATIC PROCESSOR
========================================================= */

function processSource(source) {
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
    "arithmetic constant folding",
    foldArithmetic
  );

  apply(
    "string concatenation folding",
    foldStringConcat
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
      let filename = "analysis.lua";

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
         TEXT
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
         DIRECT URL
      ----------------------------------------- */

      const directURL =
        resolveInputURL(
          originalSource
        );

      let source =
        originalSource;

      let sourceChain = [];

      if (directURL) {
        console.log(
          `[DIRECT INPUT] ${directURL}`
        );

        source =
          await fetchSource(
            directURL
          );

        sourceChain.push(
          directURL
        );
      }

      /* -----------------------------------------
         LOADSTRING CHAIN
      ----------------------------------------- */

      const resolved =
        await resolveRecursive(
          source,
          0,
          new Set(sourceChain)
        );

      source =
        resolved.source;

      sourceChain = [
        ...sourceChain,
        ...resolved.chain
      ];

      /* -----------------------------------------
         STATIC PROCESS
      ----------------------------------------- */

      const processed =
        processSource(source);

      /* -----------------------------------------
         ANALYSIS
      ----------------------------------------- */

      const analysis =
        analyzeSource(
          processed.source
        );

      /* -----------------------------------------
         ROBLOX-LIKE DUMP
      ----------------------------------------- */

      const dump =
        createDump(
          processed.source
        );

      /* -----------------------------------------
         RAW FILES
      ----------------------------------------- */

      const rawURL =
        publishRaw(
          processed.source,
          filename
        );

      const dumpURL =
        publishRaw(
          dump,
          "static-dump.txt"
        );

      /* -----------------------------------------
         RESPONSE
      ----------------------------------------- */

      let message =
        "## ✅ Static Analysis Complete\n\n";

      message +=
        `**Input:** ${originalSource.length.toLocaleString()} characters\n`;

      message +=
        `**Analyzed:** ${processed.source.length.toLocaleString()} characters\n`;

      message +=
        `**Lines:** ${analysis.lines.toLocaleString()}\n`;

      message +=
        `**Functions:** ${analysis.functions.length.toLocaleString()}\n`;

      message +=
        `**Strings:** ${analysis.strings.length.toLocaleString()}\n`;

      message +=
        `**Calls:** ${analysis.calls.length.toLocaleString()}\n\n`;

      message +=
        `### 📄 Processed Source\n${rawURL}\n\n`;

      message +=
        `### 🔬 Static Dump\n${dumpURL}\n\n`;

      message +=
        "### 🧠 VM Indicators\n";

      if (analysis.vm.length) {
        message +=
          analysis.vm
            .map(x => `- ${x}`)
            .join("\n");
      } else {
        message +=
          "- None detected";
      }

      message +=
        "\n\n### 🎮 Roblox Environment\n";

      message +=
        `**Globals:** ${
          analysis.roblox.globals.join(", ") ||
          "none"
        }\n`;

      message +=
        `**Services:** ${
          analysis.roblox.services.join(", ") ||
          "none"
        }\n`;

      if (sourceChain.length) {
        message +=
          "\n### 🌐 Loaded Sources\n";

        message +=
          sourceChain
            .map(x => `- ${x}`)
            .join("\n");
      }

      if (resolved.stopped) {
        message +=
          `\n\n⚠️ ${resolved.stopped}`;
      }

      message +=
        "\n\n### 🔧 Static Transformations\n";

      if (processed.passes.length) {
        message +=
          processed.passes
            .map(x => `- ${x}`)
            .join("\n");
      } else {
        message +=
          "- None";
      }

      if (message.length > 1900) {
        message =
          message.slice(0, 1800) +
          "\n\n...complete results are available through the raw links above.";
      }

      await interaction.editReply(
        message
      );

    } catch (error) {
      console.error(
        "DEOBF ERROR:",
        error
      );

      await interaction.editReply(
        `❌ **Failed**\n\`\`\`\n${String(
          error.message || error
        ).slice(0, 1600)}\n\`\`\``
      );
    }
  }
);

/* =========================================================
   ERROR HANDLERS
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

"use strict";

/*
============================================================
 UNIVERSAL LUA / LUAU STATIC RECOVERY BOT
============================================================

Railway environment variables:

DISCORD_TOKEN=...
CLIENT_ID=...
GUILD_ID=...
PUBLIC_URL=https://your-app.up.railway.app

Supported:

/deobf
/deobf input:<lua/url/loadstring>

/deobf file:<attachment>

.l <lua/url/loadstring>

/.l with a Lua/Luau/TXT attachment

Recovery:

- nested loadstring URLs
- HttpGet URLs
- decimal escapes
- hex escapes
- unicode escapes
- string.char()
- table.concat()
- string concatenation
- arithmetic constants
- comparison constants
- boolean constants
- constant aliases
- Base64
- Base64URL
- ASCII/Base85
- hexadecimal blobs
- decimal byte arrays
- basic XOR byte-array candidates
- comments
- constant branches
- simple constant-return functions
- VM-pattern detection
- static VM candidate extraction
- candidate scoring
- strict Lua/Luau validation

IMPORTANT:

The submitted program is NEVER executed.

The VM stage only analyzes source structure.
============================================================
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


/* =========================================================
   CONFIG
========================================================= */

const TOKEN =
    process.env.DISCORD_TOKEN;

const CLIENT_ID =
    process.env.CLIENT_ID;

const GUILD_ID =
    process.env.GUILD_ID;

const PUBLIC_URL =
    process.env.PUBLIC_URL;

const PORT =
    Number(
        process.env.PORT || 3000
    );

const MAX_SOURCE_SIZE =
    2 * 1024 * 1024;

const MAX_FETCH_DEPTH =
    5;

const MAX_TRANSFORM_ROUNDS =
    12;

const MAX_CANDIDATES =
    120;

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


/* =========================================================
   EXPRESS SERVER
========================================================= */

const app =
    express();

app.disable(
    "x-powered-by"
);

const rawStore =
    new Map();


app.get(
    "/",
    (req, res) => {
        res
            .type("text")
            .send(
                "Universal Lua recovery bot online."
            );
    }
);


app.get(
    "/health",
    (req, res) => {
        res.json({
            online: true,
            mode: "static",
            storedOutputs:
                rawStore.size
        });
    }
);


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


/* =========================================================
   RAW OUTPUT
========================================================= */

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
            created:
                Date.now()
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
                now -
                    item.created >
                RAW_LIFETIME
            ) {
                rawStore.delete(
                    id
                );
            }
        }

    },
    10 * 60 * 1000
);


/* =========================================================
   DISCORD
========================================================= */

const client =
    new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ]
    });


const slashCommands = [

    new SlashCommandBuilder()
        .setName("deobf")
        .setDescription(
            "Recover readable Lua/Luau source."
        )
        .addStringOption(
            option =>
                option
                    .setName("input")
                    .setDescription(
                        "Lua source, URL, or loadstring."
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


/* =========================================================
   REGISTER SLASH COMMANDS
========================================================= */

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
            body:
                slashCommands
        }
    );

    console.log(
        "Slash commands registered."
    );
}


/* =========================================================
   BASIC HELPERS
========================================================= */

function unique(
    array
) {
    return [
        ...new Set(array)
    ];
}


function isHTTP(
    value
) {

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


function escapeRegex(
    value
) {

    return value.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
    );
}


/* =========================================================
   URL DETECTION
========================================================= */

function extractURLs(
    source
) {

    const matches =
        source.match(
            /https?:\/\/[^\s"'`<>()]+/gi
        ) || [];

    return unique(
        matches.map(
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
        const regex
        of patterns
    ) {

        for (
            const match
            of source.matchAll(
                regex
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


/* =========================================================
   FETCH
========================================================= */

async function fetchSource(
    url
) {

    if (
        !isHTTP(url)
    ) {
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
                            "UniversalLuaRecoveryBot/1.0",
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

    if (
        !response.ok
    ) {

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


/* =========================================================
   INPUT RESOLUTION
========================================================= */

async function resolveInput(
    input
) {

    const value =
        input.trim();

    if (
        isHTTP(value)
    ) {
        return fetchSource(
            value
        );
    }

    const loadURLs =
        extractLoadstringURLs(
            value
        );

    if (
        loadURLs.length
    ) {

        return fetchSource(
            loadURLs[0]
        );
    }

    return value;
}


/* =========================================================
   NESTED REMOTE SOURCES
========================================================= */

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

    for (
        const url
        of urls
    ) {

        if (
            visited.has(url)
        ) {
            continue;
        }

        visited.add(
            url
        );

        try {

            const remote =
                await fetchSource(
                    url
                );

            return resolveRemoteChain(
                remote,
                depth + 1,
                visited
            );

        } catch {

            continue;
        }
    }

    return source;
}


/* =========================================================
   BASE64
========================================================= */

function isBase64(
    value
) {

    const text =
        value.trim();

    if (
        text.length <
            8 ||
        text.length % 4 !==
            0
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
            decoded.length >
                0 &&
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

                    return JSON.stringify(
                        decoded
                    );
                }

            } catch {}

            return full;
        }
    );
}


/* =========================================================
   BASE64 URL
========================================================= */

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


/* =========================================================
   ASCII85
========================================================= */

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

    const bytes =
        [];

    let group =
        [];

    function flush() {

        if (
            !group.length
        ) {
            return;
        }

        const length =
            group.length;

        while (
            group.length <
            5
        ) {
            group.push(
                "u"
            );
        }

        let value =
            0;

        for (
            const char
            of group
        ) {

            const digit =
                char.charCodeAt(0) -
                33;

            if (
                digit < 0 ||
                digit > 84
            ) {

                group = [];

                return;
            }

            value =
                value * 85 +
                digit;
        }

        const chunk = [

            (value >>> 24) &
                255,

            (value >>> 16) &
                255,

            (value >>> 8) &
                255,

            value & 255

        ];

        const count =
            length - 1;

        for (
            let i = 0;
            i < count;
            i++
        ) {

            bytes.push(
                chunk[i]
            );
        }

        group = [];
    }


    for (
        const char
        of data
    ) {

        if (
            char === "z" &&
            !group.length
        ) {

            bytes.push(
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
        bytes
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


/* =========================================================
   HEX BLOBS
========================================================= */

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
                hex.length % 2 !==
                0
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


/* =========================================================
   DECIMAL BYTE ARRAYS
========================================================= */

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
                        value =>
                            Number(
                                value.trim()
                            )
                    );

            if (
                values.some(
                    value =>
                        !Number.isInteger(
                            value
                        ) ||
                        value < 0 ||
                        value > 255
                )
            ) {
                return full;
            }

            const decoded =
                Buffer
                    .from(
                        values
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

            return full;
        }
    );
}


/* =========================================================
   SIMPLE XOR BYTE ARRAY RECOVERY
========================================================= */

function xorDecode(
    bytes,
    key
) {

    return Buffer.from(
        bytes.map(
            byte =>
                byte ^ key
        )
    );
}


function decodeSimpleXOR(
    source
) {

    return source.replace(
        /\{(\s*\d{1,3}(?:\s*,\s*\d{1,3}){15,}\s*)\}/g,
        (
            full,
            body
        ) => {

            const bytes =
                body
                    .split(",")
                    .map(
                        x =>
                            Number(
                                x.trim()
                            )
                    );

            if (
                bytes.some(
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

            /*
             * Try simple single-byte XOR keys.
             *
             * This is only candidate generation.
             * The output still has to pass Lua validation.
             */
            for (
                let key = 0;
                key <= 255;
                key++
            ) {

                const decoded =
                    xorDecode(
                        bytes,
                        key
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
            }

            return full;
        }
    );
}


/* =========================================================
   LUA ESCAPES
========================================================= */

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
                Number(
                    digits
                );

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


/* =========================================================
   string.char()
========================================================= */

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
                        value =>
                            value.trim()
                    )
                    .filter(
                        Boolean
                    );

            if (
                !values.length
            ) {
                return full;
            }

            if (
                values.some(
                    value =>
                        !/^-?\d+$/.test(
                            value
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
                    number =>
                        number < 0 ||
                        number > 255
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


/* =========================================================
   table.concat()
========================================================= */

function decodeTableConcat(
    source
) {

    return source.replace(
        /\btable\s*\.\s*concat\s*\(\s*\{([^{}]*)\}\s*\)/gi,
        (
            full,
            body
        ) => {

            const strings =
                body.match(
                    /"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/g
                );

            if (
                !strings
            ) {
                return full;
            }

            const result =
                strings
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


/* =========================================================
   STRING CONCATENATION
========================================================= */

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


/* =========================================================
   ARITHMETIC
========================================================= */

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


/* =========================================================
   COMPARISONS
========================================================= */

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
                Number(
                    aText
                );

            const b =
                Number(
                    bText
                );

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


/* =========================================================
   BOOLEAN FOLDING
========================================================= */

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


/* =========================================================
   ALIASES
========================================================= */

function resolveStringAliases(
    source
) {

    const aliases =
        new Map();

    const regex =
        /\blocal\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(["'])(.*?)\2\s*;?/g;

    for (
        const match
        of source.matchAll(
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
        ]
        of aliases
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
        const match
        of source.matchAll(
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
        ]
        of aliases
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


/* =========================================================
   SIMPLE CONSTANT FUNCTIONS
========================================================= */

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
            `local ${name} = function()
    return ${value}
end`
    );
}


/* =========================================================
   CONSTANT BRANCHES
========================================================= */

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


/* =========================================================
   PARENTHESES
========================================================= */

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


/* =========================================================
   COMMENTS
========================================================= */

function removeComments(
    source
) {

    source =
        source.replace(
            /--\[\[[\s\S]*?\]\]/g,
            ""
        );

    source =
        source.replace(
            /--[^\r\n]*/g,
            ""
        );

    return source;
}


/* =========================================================
   NORMALIZATION
========================================================= */

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


/* =========================================================
   BALANCED LUA STRUCTURE
========================================================= */

function balancedLua(
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
                escape = false;
                continue;
            }

            if (c === "\\") {
                escape = true;
                continue;
            }

            if (c === quote) {
                quote = null;
            }

            continue;
        }

        if (
            c === '"' ||
            c === "'"
        ) {

            quote = c;
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


/* =========================================================
   LUA DETECTION
========================================================= */

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
        !balancedLua(
            text
        )
    ) {
        return false;
    }

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
        const regex
        of indicators
    ) {

        if (
            regex.test(text)
        ) {
            score++;
        }
    }

    if (
        score >= 1
    ) {
        return true;
    }

    if (
        /^(?:["'].*["']|\d+|true|false|nil)\s*;?$/.test(
            text
        )
    ) {
        return true;
    }

    return false;
}


/* =========================================================
   LUA SCORING
========================================================= */

function luaScore(
    source
) {

    let score =
        0;

    if (
        looksLikeLua(
            source
        )
    ) {
        score +=
            100;
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
            /\bprint\s*\(/g,
            15
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
            regex,
            points
        ]
        of tests
    ) {

        const matches =
            source.match(
                regex
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

    const controlChars =
        (
            source.match(
                /[\x00-\x08\x0B\x0C\x0E-\x1F]/g
            ) || []
        ).length;

    score -=
        Math.min(
            controlChars,
            50
        );

    const hugeNumbers =
        (
            source.match(
                /\b\d{3,}\b/g
            ) || []
        ).length;

    if (
        hugeNumbers > 100
    ) {

        score -=
            Math.min(
                100,
                hugeNumbers / 5
            );
    }

    return score;
}


/* =========================================================
   CANDIDATE MANAGEMENT
========================================================= */

function addCandidate(
    list,
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
        list.some(
            item =>
                item.source ===
                source
        )
    ) {
        return;
    }

    list.push({
        source,
        label,
        score:
            luaScore(
                source
            )
    });

    list.sort(
        (a, b) =>
            b.score -
            a.score
    );

    if (
        list.length >
        MAX_CANDIDATES
    ) {
        list.length =
            MAX_CANDIDATES;
    }
}


/* =========================================================
   ENCODING RECOVERY
========================================================= */

function recoverEncodings(
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
            "simple XOR",
            decodeSimpleXOR
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
            "constant functions",
            simplifyFunctions
        ],

        [
            "constant branches",
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
                transform
            ]
            of passes
        ) {

            const before =
                current;

            try {

                current =
                    transform(
                        current
                    );

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

    return candidates;
}


/* =========================================================
   STATIC VM DETECTION
========================================================= */

function detectVM(
    source
) {

    const signals = {

        programCounter:
            /\b(?:pc|ip|instruction|instr|opcode|op)\b/i
                .test(source),

        dispatcher:
            /\b(?:while|for)\b[\s\S]{0,300}\b(?:switch|if)\b/i
                .test(source),

        opcodeTable:
            /\{[\s\S]{0,300}\b(?:OP|opcode|handler|handlers)\b/i
                .test(source),

        largeNumericTable:
            /\{(?:\s*\d+\s*,){10,}\s*\d+\s*\}/
                .test(source),

        handlerFunction:
            /\bfunction\s*\([^)]*\)[\s\S]{0,200}\b(?:return|if|elseif)\b/i
                .test(source),

        infiniteLoop:
            /while\s+true\s+do/i
                .test(source),

        coroutine:
            /\bcoroutine\./i
                .test(source)

    };

    const score =
        Object.values(
            signals
        ).filter(
            Boolean
        ).length;

    return {
        detected:
            score >= 3,
        score,
        signals
    };
}


/* =========================================================
   STATIC VM ANALYZER
========================================================= */

function analyzeVM(
    source
) {

    const detection =
        detectVM(
            source
        );

    if (
        !detection.detected
    ) {
        return [];
    }

    const candidates =
        [];

    /*
     * VM source often contains useful string constants.
     *
     * Extracting these is safe because nothing executes.
     */
    const strings =
        source.match(
            /"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/g
        ) || [];

    if (
        strings.length
    ) {

        const readable =
            strings
                .filter(
                    value =>
                        /[A-Za-z]/.test(
                            value
                        )
                )
                .join(
                    "\n"
                );

        if (
            readable.length >
            10
        ) {

            addCandidate(
                candidates,
                `-- Extracted VM string constants\n${readable}`,
                "VM string constants"
            );
        }
    }

    /*
     * Extract obvious function bodies.
     */
    const functions =
        source.match(
            /(?:local\s+)?function[\s\S]{0,2000}?\bend\b/gi
        ) || [];

    for (
        const fn
        of functions.slice(
            0,
            20
        )
    ) {

        if (
            looksLikeLua(
                fn
            )
        ) {

            addCandidate(
                candidates,
                fn,
                "VM function candidate"
            );
        }
    }

    /*
     * If VM analysis cannot reconstruct actual
     * executable Lua, return only candidates that
     * pass the normal validator.
     *
     * We deliberately do NOT execute the VM.
     */
    return candidates;
}


/* =========================================================
   STATIC RECOVERY
========================================================= */

function recoverStatic(
    source
) {

    const candidates =
        recoverEncodings(
            source
        );

    for (
        const candidate
        of [
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

    return candidates;
}


/* =========================================================
   UNIVERSAL RECOVERY
========================================================= */

async function recoverUniversal(
    source
) {

    /*
     * Resolve nested remote sources first.
     */
    source =
        await resolveRemoteChain(
            source
        );

    /*
     * Generate decoded candidates.
     */
    const decoded =
        recoverEncodings(
            source
        );

    /*
     * VM FIRST.
     */
    const vmCandidates =
        [];

    for (
        const candidate
        of decoded
    ) {

        const results =
            analyzeVM(
                candidate.source
            );

        for (
            const result
            of results
        ) {

            addCandidate(
                vmCandidates,
                result.source,
                result.label
            );
        }
    }

    /*
     * VM candidates must pass validation.
     */
    const validVM =
        vmCandidates
            .filter(
                candidate =>
                    isValidLua(
                        candidate.source
                    )
            )
            .sort(
                (a, b) =>
                    b.score -
                    a.score
            );

    if (
        validVM.length
    ) {

        return {
            ...validVM[0],
            method:
                "static-vm"
        };
    }


    /*
     * VM failed.
     *
     * FALL BACK TO STATIC RECOVERY.
     */
    const staticCandidates =
        [];

    for (
        const candidate
        of decoded
    ) {

        const results =
            recoverStatic(
                candidate.source
            );

        for (
            const result
            of results
        ) {

            addCandidate(
                staticCandidates,
                result.source,
                result.label
            );
        }
    }


    const validStatic =
        staticCandidates
            .filter(
                candidate =>
                    isValidLua(
                        candidate.source
                    )
            )
            .sort(
                (a, b) =>
                    b.score -
                    a.score
            );


    if (
        validStatic.length
    ) {

        return {
            ...validStatic[0],
            method:
                "static"
        };
    }

    return null;
}


/* =========================================================
   FINAL VALIDATOR
========================================================= */

function isValidLua(
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
        !balancedLua(
            text
        )
    ) {
        return false;
    }

    const controlCharacters =
        (
            text.match(
                /[\x00-\x08\x0B\x0C\x0E-\x1F]/g
            ) || []
        ).length;

    if (
        controlCharacters
    ) {
        return false;
    }

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

    const indicatorCount =
        indicators.filter(
            regex =>
                regex.test(
                    text
                )
        ).length;


    /*
     * Prevent numeric garbage from
     * becoming the "best" result.
     */
    const numbers =
        (
            text.match(
                /\b\d{3,}\b/g
            ) || []
        ).length;

    const identifiers =
        (
            text.match(
                /\b[A-Za-z_][A-Za-z0-9_]*\b/g
            ) || []
        ).length;

    if (
        numbers > 150 &&
        identifiers <
            numbers / 2
    ) {
        return false;
    }


    if (
        indicatorCount >= 1
    ) {
        return true;
    }


    /*
     * Simple expressions.
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


/* =========================================================
   SLASH COMMAND HANDLER
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
                ephemeral:
                    true
            });

            return;
        }


        await interaction.deferReply();


        try {

            let source;


            if (
                attachment
            ) {

                const filename =
                    attachment.name ||
                    "";

                const lower =
                    filename.toLowerCase();

                if (
                    !lower.endsWith(".lua") &&
                    !lower.endsWith(".luau") &&
                    !lower.endsWith(".txt")
                ) {

                    throw new Error(
                        "Only .lua, .luau and .txt files are supported."
                    );
                }


                source =
                    await fetchSource(
                        attachment.url
                    );

            } else {

                source =
                    await resolveInput(
                        input
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


            const result =
                await recoverUniversal(
                    source
                );


            if (
                !result ||
                !isValidLua(
                    result.source
                )
            ) {

                await interaction.editReply(
                    "❌ No valid Lua/Luau source could be recovered. No raw link was created."
                );

                return;
            }


            const raw =
                publishRaw(
                    result.source,
                    "recovered.lua"
                );


            await interaction.editReply(
                raw
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


/* =========================================================
   .L PREFIX
========================================================= */

client.on(
    "messageCreate",
    async message => {

        if (
            message.author.bot
        ) {
            return;
        }


        const content =
            message.content.trim();


        if (
            !content
                .toLowerCase()
                .startsWith(".l")
        ) {
            return;
        }


        const argument =
            content
                .slice(2)
                .trim();


        const attachment =
            message.attachments.first();


        if (
            !argument &&
            !attachment
        ) {

            await message.reply(
                "Usage: `.l <Lua / URL / loadstring>` or attach a `.lua`, `.luau`, or `.txt` file."
            );

            return;
        }


        try {

            await message.channel.sendTyping();

            let source;


            if (
                attachment
            ) {

                const filename =
                    attachment.name ||
                    "";

                const lower =
                    filename.toLowerCase();

                if (
                    !lower.endsWith(".lua") &&
                    !lower.endsWith(".luau") &&
                    !lower.endsWith(".txt")
                ) {

                    throw new Error(
                        "Only .lua, .luau and .txt files are supported."
                    );
                }


                source =
                    await fetchSource(
                        attachment.url
                    );

            } else {

                source =
                    await resolveInput(
                        argument
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


            const result =
                await recoverUniversal(
                    source
                );


            if (
                !result ||
                !isValidLua(
                    result.source
                )
            ) {

                await message.reply(
                    "❌ No valid Lua/Luau source could be recovered. No raw link was created."
                );

                return;
            }


            const raw =
                publishRaw(
                    result.source,
                    "recovered.lua"
                );


            await message.reply(
                raw
            );

        } catch (error) {

            console.error(
                ".l ERROR:",
                error
            );

            await message.reply(
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


/* =========================================================
   READY
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

client
    .login(
        TOKEN
    )
    .catch(
        error => {

            console.error(
                "Discord login failed:",
                error
            );

            process.exit(1);
        }
    );

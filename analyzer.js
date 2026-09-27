function analyzeLua(source) {
  const result = {
    fileSize: source.length,
    lines: source.split(/\r?\n/).length,
    functions: 0,
    strings: [],
    patterns: []
  };

  // Find strings
  for (const match of source.matchAll(/(["'])(.*?)\1/g)) {
    result.strings.push(match[2]);
  }

  // Count functions
  result.functions =
    (source.match(/\bfunction\b/g) || []).length;

  // Identify common obfuscation indicators
  const checks = [
    ["loadstring", /\bloadstring\s*\(/],
    ["load", /\bload\s*\(/],
    ["string.char", /\bstring\.char\s*\(/],
    ["string.byte", /\bstring\.byte\s*\(/],
    ["getfenv", /\bgetfenv\s*\(/],
    ["setfenv", /\bsetfenv\s*\(/],
    ["debug library", /\bdebug\./],
    ["large numeric table", /\{(?:\s*\d+\s*,){20,}/]
  ];

  for (const [name, regex] of checks) {
    if (regex.test(source)) {
      result.patterns.push(name);
    }
  }

  return result;
}

module.exports = { analyzeLua };

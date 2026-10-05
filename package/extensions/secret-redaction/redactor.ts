import { randomBytes } from "node:crypto";

export const PLACEHOLDER_SOURCE = "__WPI_SECRET_[a-f0-9]{16}_[a-f0-9]{24}__";
const placeholderPattern = () => new RegExp(PLACEHOLDER_SOURCE, "g");
const MAX_SECRET_LENGTH = 64 * 1024;
const COMMON_VALUES = new Set(["password", "changeme", "redacted", "example", "undefined", "localhost", "development"]);

// Placeholders whose ID starts with this mark stand for values that are masked
// only where they are assigned, never searched for elsewhere. Keeping the flag
// in the placeholder itself means reloads, forks, and child agents agree on it
// without any change to the stored records.
const CONTEXT_ONLY_MARK = "00c0de00";
const isContextOnly = (token: string) => token.slice(-26, -2).startsWith(CONTEXT_ONLY_MARK);

export interface SecretStorage {
  scope: string;
  load(): Iterable<[string, string]>;
  read(token: string): string | undefined;
  write(token: string, value: string): void;
}

interface Span { start: number; end: number; value: string; contextOnly?: boolean }

// Words that follow `name =` or `name:` in source code and are never credentials.
const CODE_WORDS = new Set(["null", "nil", "none", "undefined", "true", "false", "await", "async", "new", "this", "self",
  "typeof", "void", "function", "return", "yield", "string", "str", "number", "boolean", "bool", "int", "float", "any",
  "unknown", "object", "never", "required", "optional"]);
// An identifier, optionally a member chain: `accessToken`, `req.headers.authorization`, `self._token`, `Auth::Token`.
const IDENTIFIER_CHAIN = /^\$?[A-Za-z_]+(?:(?:\?\.|!\.|\.|::|->)[A-Za-z_]+)*/;

/**
 * Judge the unquoted right-hand side of `name = value` found in free text.
 * Source code puts expressions there far more often than literals, and masking
 * those leaves the model reading auth code with holes in it.
 *
 *   "none"    — unmistakably code (`generatePassword()`, `await`, `string`): left as is.
 *   "context" — shaped like an identifier (`accessToken`, `config.auth.token`). It could
 *               still be a literal (`password: hunter`), so it is masked where assigned
 *               but not hunted for elsewhere.
 *   "secret"  — anything else (digits, punctuation): a credential, masked everywhere.
 *
 * Structured fields, environment variables, dotenv files, and quoted strings never
 * pass through here: a literal learned from those is always a full secret.
 */
function unquotedConfidence(value: string): "secret" | "context" | "none" {
  if (!/[A-Za-z0-9]/.test(value) || CODE_WORDS.has(value.toLowerCase())) return "none";
  if (/\d/.test(value)) return "secret";
  const chain = IDENTIFIER_CHAIN.exec(value)?.[0] ?? "";
  if (chain && value[chain.length] === "(") return "none";
  return chain && /^[)!?]*$/.test(value.slice(chain.length)) ? "context" : "secret";
}

/** Deliberately excludes KEY, TOKEN_COUNT, PASSWORD_FILE, API_KEY_NAME, etc. */
function normalizeName(name: string): string {
  return name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase();
}

export function isCredentialName(name: string): boolean {
  const normalized = normalizeName(name);
  return /(?:^|_)(?:api_key|access_key(?:_id)?|secret_key|private_key|client_secret|signing_key|encryption_key|password|passwd|pwd|secret|token|credentials?|authorization|auth|cookie)$/.test(normalized);
}

function isCandidate(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SECRET_LENGTH &&
    !value.includes("__WPI_SECRET_") && !/^\$\{?[A-Z_][A-Z0-9_]*\}?$/.test(value) &&
    !/^process\.env\./.test(value) &&
    !(/^[A-Z_][A-Z0-9_]+$/.test(value) && Object.hasOwn(process.env, value));
}

/** Find credential values, preserving their surrounding syntax byte-for-byte. */
function credentialSpans(text: string, key: string, matchesName: (name: string) => boolean): Span[] {
  const spans: Span[] = [];
  const add = (start: number, value: string, contextOnly = false) => {
    if (isCandidate(value)) spans.push({ start, end: start + value.length, value, contextOnly });
  };

  if (matchesName(key)) {
    const authorization = /^(?:Bearer|Basic)\s+(\S+)$/i.exec(text);
    if (authorization) add(text.length - authorization[1].length, authorization[1]);
    else add(0, text);
  }

  // Dotenv, YAML, JSON, query parameters, and common log key=value formats.
  // Quoted values may contain whitespace, escaped quotes, or PEM newlines.
  // `:=` assigns (Go, Make); `==`, `=>`, and `::` are operators, not assignments.
  const assignments = /(?<![\w.-])["']?([A-Za-z_][A-Za-z0-9_.-]{0,127})["']?[ \t]*(?::=|[:=](?![=>:]))[ \t]*/g;
  for (const match of text.matchAll(assignments)) {
    if (!matchesName(match[1])) continue;
    const offset = match.index! + match[0].length;
    const parsed = /^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s,;#&{}\[\]"'`]+))/.exec(text.slice(offset));
    if (!parsed) continue;
    const value = parsed[1] ?? parsed[2] ?? parsed[3];
    const quoted = parsed[1] !== undefined || parsed[2] !== undefined;
    const start = offset + (quoted ? 1 : 0);
    const authorization = /^(?:Bearer|Basic)\s+(\S+)$/i.exec(value);
    if (authorization) add(start + value.length - authorization[1].length, authorization[1]);
    else if (!/^(?:Bearer|Basic)\s*$/i.test(value)) {
      const confidence = quoted ? "secret" : unquotedConfidence(value);
      if (confidence !== "none") add(start, value, confidence === "context");
    }
  }

  for (const match of text.matchAll(/\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+\/=\-]+)/gi)) {
    add(match.index! + match[0].length - match[1].length, match[1]);
  }
  for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:"'<>]+:([^\s/@"'<>]+)@/gi)) {
    add(match.index! + match[0].length - match[1].length - 1, match[1]);
  }
  const formats = [
    /-----BEGIN ((?:[A-Z0-9]+ )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
    /\b(?:sk-(?:(?:ant-(?:api\d{2}|oat\d{2})|proj|svcacct)-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[A-Za-z0-9_-]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,})\b/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  ];
  for (const pattern of formats) {
    for (const match of text.matchAll(pattern)) add(match.index!, match[0]);
  }
  return spans;
}

const opaqueKeys = new Set(["thoughtSignature", "thinkingSignature", "encrypted_content"]);
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isOpaque(value: Record<string, unknown>): boolean {
  return ["image", "image_url", "input_image", "input_audio", "audio", "redacted_thinking"].includes(value.type as string);
}

/** Walk parsed string values, not serialized JSON. Never alter keys or binary/signature data. */
function mapStrings<T>(value: T, visit: (text: string, key: string) => string, preserveOpaque = true): T {
  const seen = new WeakMap<object, unknown>();
  function walk(item: unknown, key = ""): unknown {
    if (typeof item === "string") return visit(item, key);
    if (!Array.isArray(item) && !isPlainObject(item)) return item;
    if (preserveOpaque && !Array.isArray(item) && isOpaque(item)) return item;
    if (seen.has(item)) return seen.get(item);
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      seen.set(item, result);
      for (const entry of item) result.push(walk(entry));
      return result;
    }
    const result: Record<string, unknown> = {};
    seen.set(item, result);
    for (const [name, entry] of Object.entries(item)) {
      const opaque = opaqueKeys.has(name) || (name === "signature" && ["thinking", "reasoning"].includes(item.type as string));
      Object.defineProperty(result, name, {
        value: preserveOpaque && opaque ? entry : walk(entry, name),
        enumerable: true, writable: true, configurable: true,
      });
    }
    return result;
  }
  return walk(value) as T;
}

export class SecretRedactor {
  private readonly byValue = new Map<string, string>();
  private readonly byToken = new Map<string, string>();
  private knownPattern: RegExp | undefined;
  private readonly scope: string;
  private credentialKeys = new Set<string>();

  /** Additional exact names, normalized like built-in names; never replace defaults. */
  setCredentialKeys(keys: Iterable<string>): void {
    this.credentialKeys = new Set([...keys].map(normalizeName));
  }

  isCredentialName(name: string): boolean {
    return isCredentialName(name) || this.credentialKeys.has(normalizeName(name));
  }

  constructor(private readonly storage?: SecretStorage) {
    this.scope = storage?.scope ?? randomBytes(8).toString("hex");
    if (storage) for (const [token, value] of storage.load()) this.remember(token, value);
  }

  private remember(token: string, value: string): void {
    this.byToken.set(token, value);
    // One canonical placeholder per value; a full secret outranks a context-only one.
    const current = this.byValue.get(value);
    if (current === undefined || (isContextOnly(current) && !isContextOnly(token))) this.byValue.set(value, token);
    this.knownPattern = undefined;
  }

  /**
   * Learn a credential and return its placeholder. A `contextOnly` value is masked
   * where it was found but not searched for in other text; registering the same
   * value again as a full secret upgrades it.
   */
  registerSecret(value: string, contextOnly = false): string {
    if (!isCandidate(value)) return value;
    const existing = this.byValue.get(value);
    if (existing && (contextOnly || !isContextOnly(existing))) return existing;
    let id = contextOnly ? CONTEXT_ONLY_MARK + randomBytes(8).toString("hex") : randomBytes(12).toString("hex");
    while (!contextOnly && id.startsWith(CONTEXT_ONLY_MARK)) id = randomBytes(12).toString("hex");
    const token = `__WPI_SECRET_${this.scope}_${id}__`;
    // Persist before exposing a token so reloads and subprocesses can resolve it.
    this.storage?.write(token, value);
    this.remember(token, value);
    return token;
  }

  private resolve(token: string): string | undefined {
    let value = this.byToken.get(token);
    if (value === undefined) {
      value = this.storage?.read(token);
      if (value !== undefined) this.remember(token, value);
    }
    return value;
  }

  /** Two passes also redact occurrences appearing before their identifying field. */
  discover<T>(value: T): void {
    mapStrings(value, (text, key) => {
      for (const match of text.matchAll(placeholderPattern())) this.resolve(match[0]);
      for (const span of credentialSpans(text, key, name => this.isCredentialName(name))) {
        this.registerSecret(span.value, span.contextOnly);
      }
      return text;
    });
  }

  private redactString(text: string, key: string): string {
    const spans = credentialSpans(text, key, name => this.isCredentialName(name));
    // Short, common, and context-only values are masked only in credential fields, never throughout code.
    if (!this.knownPattern) {
      const values = [...this.byValue].filter(([value, token]) =>
        value.length >= 8 && !COMMON_VALUES.has(value.toLowerCase()) && !isContextOnly(token))
        .map(([value]) => value).sort((a, b) => b.length - a.length);
      this.knownPattern = new RegExp(values.length
        ? values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
        : "(?!)", "g");
    }
    for (const match of text.matchAll(this.knownPattern)) {
      spans.push({ start: match.index!, end: match.index! + match[0].length, value: match[0] });
    }
    const placeholders = [...text.matchAll(placeholderPattern())].map(match => ({
      start: match.index!, end: match.index! + match[0].length,
    }));
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    let end = 0;
    let result = "";
    for (const span of spans) {
      if (span.start < end || placeholders.some(p => span.start < p.end && span.end > p.start)) continue;
      result += text.slice(end, span.start) + this.registerSecret(span.value, span.contextOnly);
      end = span.end;
    }
    return result + text.slice(end);
  }

  redact<T>(value: T): T {
    this.discover(value);
    return mapStrings(value, (text, key) => this.redactString(text, key));
  }

  /** Restore only execution arguments; callers keep model-facing history tokenized. */
  restore<T>(value: T, shell = false): T {
    return mapStrings(value, text => {
      // Also reject truncated concrete tokens, while allowing the literal prefix
      // and __WPI_SECRET_...__ notation used in documentation.
      const remainder = text.replace(/__WPI_SECRET_[A-Za-z0-9_-]+?__/g, "");
      if (/__WPI_SECRET_[A-Za-z0-9]/.test(remainder)) {
        throw new Error("Unknown secret placeholder. Re-read its source; the placeholder may have been truncated.");
      }
      return text.replace(/__WPI_SECRET_[A-Za-z0-9_-]+?__/g, token => {
        const original = new RegExp(`^${PLACEHOLDER_SOURCE}$`).test(token) ? this.resolve(token) : undefined;
        if (original === undefined) {
          throw new Error("Unknown secret placeholder. Re-read its source; the local secret mapping may have been removed.");
        }
        if (shell && /[^A-Za-z0-9_./:@%+=,-]/.test(original)) {
          throw new Error("Secret cannot be safely inserted into shell syntax. Use a quoted environment-variable reference or load it from its local file instead.");
        }
        return original;
      });
    }, false);
  }

  get size(): number { return this.byValue.size; }
}

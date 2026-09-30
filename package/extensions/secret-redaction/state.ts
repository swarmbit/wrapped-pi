import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import yaml from "js-yaml";
import { PLACEHOLDER_SOURCE, SecretRedactor, type SecretStorage } from "./redactor";

/** Config errors must not echo YAML snippets that may contain credentials. */
function readCredentialKeys(filename: string): string[] {
  let text: string;
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return [];
    text = fs.readFileSync(filename, "utf8");
  } catch { return []; }
  try {
    const config = yaml.load(text, { schema: yaml.JSON_SCHEMA }) as { secretRedaction?: { keys?: unknown } } | undefined;
    const keys = config?.secretRedaction?.keys;
    if (keys === undefined) return [];
    if (!Array.isArray(keys) || keys.some(key => typeof key !== "string" || !key.trim())) throw new Error();
    return keys.map(key => key.trim());
  } catch {
    throw new Error("Invalid secretRedaction.keys configuration; expected a list of non-empty key names in wpi.yml");
  }
}

const MAX_FILE_BYTES = 1024 * 1024;
const tokenPattern = new RegExp(`^${PLACEHOLDER_SOURCE}$`);

/** Immutable per-secret records avoid lost updates between parallel subagents. */
export class FileSecretStorage implements SecretStorage {
  readonly scope: string;
  constructor(private readonly root: string, sessionId: string) {
    this.scope = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  }

  private filename(token: string): string {
    if (!tokenPattern.test(token)) throw new Error("Invalid secret placeholder");
    const [scope, id] = token.slice("__WPI_SECRET_".length, -2).split("_");
    return path.join(this.root, scope, `${id}.json`);
  }

  *load(): Iterable<[string, string]> {
    const directory = path.join(this.root, this.scope);
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory)) {
      if (!/^[a-f0-9]{24}\.json$/.test(name)) continue;
      const token = `__WPI_SECRET_${this.scope}_${name.slice(0, -5)}__`;
      const value = this.read(token);
      if (value !== undefined) yield [token, value];
    }
  }

  read(token: string): string | undefined {
    const filename = this.filename(token);
    try {
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Invalid secret mapping");
      const record = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (record.version !== 1 || typeof record.secret !== "string" || record.secret.length > 64 * 1024) {
        throw new Error("Invalid secret mapping");
      }
      return record.secret;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // JSON parser errors can include credential text: never propagate them.
      throw new Error("Cannot read the local secret mapping");
    }
  }

  write(token: string, value: string): void {
    try {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const directory = path.dirname(this.filename(token));
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Publish a complete record atomically; readers never observe partial JSON.
      const temporary = path.join(directory, `.${process.pid}-${path.basename(this.filename(token))}`);
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, secret: value }), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.filename(token));
    } catch {
      throw new Error("Cannot save the local secret mapping");
    }
  }
}

/** Consult literal environment references in Pi config, but never run credential commands. */
function discoverAuth(redactor: SecretRedactor, document: unknown): void {
  if (!document || typeof document !== "object") return;
  for (const [key, value] of Object.entries(document)) {
    if (typeof value === "string" && (["key", "access", "refresh"].includes(key) || redactor.isCredentialName(key)) && !value.startsWith("!")) {
      redactor.registerSecret(process.env[value] ?? value);
    } else if (value && typeof value === "object") discoverAuth(redactor, value);
  }
}

export class SessionSecrets {
  readonly redactor: SecretRedactor;
  private readonly scanned = new Map<string, string>();
  private configuredKeys = "";

  constructor(readonly agentDir: string, sessionId: string) {
    this.redactor = new SecretRedactor(new FileSecretStorage(path.join(agentDir, "secret-redaction"), sessionId));
  }

  scanFile(filename: string): void {
    let stat: fs.Stats;
    let text: string;
    let stamp: string;
    try {
      stat = fs.lstatSync(filename);
      // Skip symlinks, devices, FIFOs, and oversized files. Never recurse through a repo.
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
      stamp = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      if (this.scanned.get(filename) === stamp) return;
      text = fs.readFileSync(filename, "utf8");
    } catch {
      return; // Optional source missing or unreadable; outgoing text is still inspected.
    }
    let document: unknown;
    if (filename.endsWith(".json")) {
      try { document = JSON.parse(text); } catch { /* scan malformed files as text */ }
    } else if (path.basename(filename) === "wpi.yml") {
      try { document = yaml.load(text, { schema: yaml.JSON_SCHEMA }); } catch { /* scan malformed files as text */ }
    }
    if (document !== undefined) {
      if (["auth.json", "models.json"].includes(path.basename(filename))) discoverAuth(this.redactor, document);
      this.redactor.discover(document);
    }
    this.redactor.discover(text);
    // Dotenv interprets escaped newlines in double quotes. Learn the decoded value too.
    for (const match of text.matchAll(/(?:^|\n)\s*(?:export\s+)?([\w]+)\s*=\s*"((?:\\.|[^"\\])*)"/g)) {
      if (this.redactor.isCredentialName(match[1])) {
        this.redactor.registerSecret(match[2].replace(/\\n/g, "\n").replace(/\\r/g, "\r"));
      }
    }
    this.scanned.set(filename, stamp);
  }

  refresh(cwd: string): void {
    const configFiles = [...new Set([
      path.join(path.dirname(this.agentDir), "wpi.yml"),
      path.join(cwd, ".pi", "wpi.yml"),
    ])];
    const keys = [...new Set(configFiles.flatMap(readCredentialKeys))].sort();
    const signature = JSON.stringify(keys);
    if (signature !== this.configuredKeys) {
      this.redactor.setCredentialKeys(keys);
      this.configuredKeys = signature;
      // Previously scanned files may contain newly configured credential fields.
      this.scanned.clear();
    }
    this.redactor.discover({ ...process.env });
    this.scanFile(path.join(this.agentDir, "auth.json"));
    this.scanFile(path.join(this.agentDir, "models.json"));
    for (const filename of configFiles) this.scanFile(filename);
    let names: string[];
    try { names = fs.readdirSync(cwd); } catch { return; }
    for (const name of names) {
      if (/^\.env(?:\.|$)/.test(name) || name === ".npmrc") this.scanFile(path.join(cwd, name));
    }
  }
}

// Pi may load this module via separate extension module roots. Share by session even
// then, without placing secrets in session entries or introducing a background service.
const sharedKey = Symbol.for("wpi.secret-redaction.sessions.v1");
const shared = globalThis as typeof globalThis & { [sharedKey]?: Map<string, SessionSecrets> };

export function getSessionSecrets(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): SessionSecrets {
  const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
  const sessionId = ctx.sessionManager.getSessionId();
  const key = `${agentDir}\0${sessionId}`;
  const sessions = shared[sharedKey] ??= new Map();
  let session = sessions.get(key);
  if (!session) {
    session = new SessionSecrets(agentDir, sessionId);
    sessions.set(key, session);
  }
  session.refresh(ctx.cwd);
  return session;
}

/** For direct, structured LLM calls that do not pass through Pi's request hooks. */
export function redactForLlm<T>(value: T, ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): T {
  return getSessionSecrets(ctx).redactor.redact(value);
}

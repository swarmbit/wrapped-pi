import { describe, expect, it } from "vitest";
import { isCredentialName, PLACEHOLDER_SOURCE, SecretRedactor } from "./redactor";

const secret = "test-credential-long-enough";
const tokens = (text: string) => text.match(new RegExp(PLACEHOLDER_SOURCE, "g")) ?? [];

describe("credential detection", () => {
  it.each(["OPENAI_API_KEY", "ORG_GRADLE_PROJECT_artifactoryPassword", "refreshToken", "x-api-key", "AWS_ACCESS_KEY_ID", "_authToken", "PRIVATE_KEY", "Authorization", "APIKey", "DBPassword"])("recognizes %s", name => {
    expect(isCredentialName(name)).toBe(true);
  });
  it.each(["PATH", "HOME", "PORT", "KEY", "TOKEN_COUNT", "TOKENIZERS_PARALLELISM", "PASSWORD_FILE", "PASSWORD_MIN_LENGTH", "API_KEY_NAME", "SECRET_REDACTION_ENABLED", "PUBLIC_KEY"])("preserves ordinary config %s", name => {
    expect(isCredentialName(name)).toBe(false);
  });

  it("redacts dotenv credentials without changing configuration or formatting", () => {
    const redactor = new SecretRedactor();
    const text = `PORT=3000\nexport API_KEY="${secret}" # keep\nDB_PASSWORD='tiny'\nTOKEN_COUNT=100\n`;
    const result = redactor.redact(text);
    expect(result).not.toContain(secret);
    expect(result).not.toContain("tiny");
    expect(result).toContain("PORT=3000");
    expect(result).toContain("TOKEN_COUNT=100");
    expect(result).toContain('" # keep');
    expect(redactor.restore(result)).toBe(text);
  });

  it("discovers across a complete structured payload before replacing any occurrence", () => {
    const redactor = new SecretRedactor();
    const original = { messages: [{ content: `An unlabeled value: ${secret}` }], details: { apiKey: secret } };
    const result = redactor.redact(original);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(original.details.apiKey).toBe(secret);
    expect(redactor.restore(result)).toEqual(original);
    expect(new Set(tokens(JSON.stringify(result))).size).toBe(1);
  });

  it("learns exact known values and uses stable opaque placeholders", () => {
    const redactor = new SecretRedactor();
    const token = redactor.registerSecret(secret);
    expect(token).toMatch(new RegExp(`^${PLACEHOLDER_SOURCE}$`));
    expect(token).not.toContain(secret);
    expect(redactor.redact(`echo ${secret}`)).toBe(`echo ${token}`);
    expect(redactor.redact(redactor.redact({ password: secret }))).toEqual({ password: token });
    expect(redactor.size).toBe(1);
  });

  it("masks short values contextually without corrupting numbers or code", () => {
    const redactor = new SecretRedactor();
    const result = redactor.redact({ password: "123", code: "const n = 123;", count: 123 });
    expect(result.password).not.toBe("123");
    expect(result.code).toBe("const n = 123;");
    expect(result.count).toBe(123);
    expect(redactor.restore(result).password).toBe("123");
  });

  it.each([
    `Authorization: Bearer ${secret}`,
    `Authorization: Basic dXNlcjpzdXBlci1zZWNyZXQ=`,
    `postgres://user:${secret}@db.internal:5432/app`,
    `https://api.example/path?access_token=${secret}&page=2`,
    `{"client_secret": "${secret}", "port": 3000}`,
    `password: "${secret}"`,
  ])("round-trips credential syntax: %s", text => {
    const redactor = new SecretRedactor();
    const result = redactor.redact(text);
    expect(tokens(result).length).toBeGreaterThan(0);
    expect(redactor.restore(result)).toBe(text);
  });

  it("does not tokenize common values or executable environment references throughout code", () => {
    const redactor = new SecretRedactor();
    const result = redactor.redact({ password: "password", code: "const password = process.env.DB_PASSWORD;" });
    expect(result.password).toMatch(/^__WPI_SECRET_/);
    expect(result.code).toBe("const password = process.env.DB_PASSWORD;");
  });

  it("finds credentials inside text fields without treating object values as secrets", () => {
    const redactor = new SecretRedactor();
    const text = `{"content":"API_KEY=${secret}","secret":{"enabled":false}}`;
    const result = redactor.redact(text);
    expect(result).not.toContain(secret);
    expect(result).toContain('"secret":{"enabled":false}');
    expect(redactor.restore(result)).toBe(text);
  });

  it("keeps authentication schemes in structured headers", () => {
    const redactor = new SecretRedactor();
    const value = { headers: { Authorization: `Bearer ${secret}` } };
    const result = redactor.redact(value);
    expect(result.headers.Authorization).toMatch(/^Bearer __WPI_SECRET_/);
    expect(redactor.restore(result)).toEqual(value);
  });

  it.each([
    "sk-proj-abcdefghijklmnopqrstuv1234",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "github_pat_abcdefghijklmnopqrstuv1234",
    "glpat-abcdefghijklmnopqrstuv1234",
    "xoxb-123456789012-abcdefghijklmnop",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
    "-----BEGIN PRIVATE KEY-----\nAAABBBCCCDDDEEE\n-----END PRIVATE KEY-----",
  ])("recognizes an unlabeled credential format", value => {
    const redactor = new SecretRedactor();
    const result = redactor.redact(`Value: ${value}`);
    expect(result).not.toContain(value);
    expect(redactor.restore(result)).toBe(`Value: ${value}`);
  });

  it("handles regex metacharacters, overlapping values, and adjacent placeholders", () => {
    const redactor = new SecretRedactor();
    redactor.registerSecret("abcdefgh");
    redactor.registerSecret("abcdefgh-more");
    redactor.registerSecret("a.b[c]+(d)$?!");
    const value = "abcdefgh-more a.b[c]+(d)$?! abcdefgh";
    expect(redactor.restore(redactor.redact(value))).toBe(value);
    expect(tokens(redactor.redact(value))).toHaveLength(3);
    const first = redactor.registerSecret("first-long-secret");
    const second = redactor.registerSecret("second-long-secret");
    expect(redactor.restore(first + second)).toBe("first-long-secretsecond-long-secret");
  });

  it("preserves JSON escaping, multiline text, keys, and value types", () => {
    const redactor = new SecretRedactor();
    const original = { password: "quote\" and slash\\ and\nnewline", input: [null, false, 42], description: "unchanged" };
    const result = redactor.redact(original);
    expect(Object.keys(result)).toEqual(Object.keys(original));
    expect(result.input).toEqual(original.input);
    expect(redactor.restore(result)).toEqual(original);
    const serialized = JSON.stringify(original);
    expect(redactor.restore(redactor.redact(serialized))).toBe(serialized);
  });

  it("leaves empty values and environment references alone", () => {
    const redactor = new SecretRedactor();
    const value = { password: "", apiKey: "${OPENAI_API_KEY}", token: "$MY_TOKEN" };
    expect(redactor.redact(value)).toEqual(value);
    expect(redactor.size).toBe(0);
  });

  it("does not touch images, provider signatures, or non-JSON objects", () => {
    const redactor = new SecretRedactor();
    redactor.registerSecret(secret);
    const value = { image: { type: "image", data: secret, mimeType: "image/png" }, thinking: { type: "thinking", signature: secret }, paths: new Set(["/tmp"]) };
    expect(redactor.redact(value)).toEqual(value);
  });

  it("handles cycles and prototype-like JSON keys safely", () => {
    const redactor = new SecretRedactor();
    const value: any = JSON.parse(`{"__proto__":{"password":"${secret}"}}`);
    value.self = value;
    const result = redactor.redact(value);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.__proto__.password).not.toBe(secret);
    expect(result.self).toBe(result);
  });
});

describe("tool argument restoration", () => {
  it("restores nested execution arguments without changing model-facing arguments", () => {
    const redactor = new SecretRedactor();
    const original = { edits: [{ oldText: `API_KEY=${secret}`, newText: `API_KEY=${secret}\nPORT=4000` }] };
    const masked = redactor.redact(original);
    expect(redactor.restore(masked)).toEqual(original);
    expect(JSON.stringify(masked)).not.toContain(secret);
  });

  it("does not mistake a tool argument named signature for an opaque provider signature", () => {
    const redactor = new SecretRedactor();
    const token = redactor.registerSecret(secret);
    expect(redactor.redact({ signature: secret })).toEqual({ signature: token });
    expect(redactor.restore({ signature: token, thoughtSignature: token })).toEqual({ signature: secret, thoughtSignature: secret });
  });

  it("rejects missing or malformed mappings without guessing", () => {
    const token = new SecretRedactor().registerSecret(secret);
    const redactor = new SecretRedactor();
    expect(() => redactor.restore({ content: token })).toThrow("Unknown secret placeholder");
    expect(() => redactor.restore("__WPI_SECRET_hallucinated__")).toThrow("Unknown secret placeholder");
    expect(() => redactor.restore(token.slice(0, -5))).toThrow("Unknown secret placeholder");
    expect(redactor.restore("__WPI_SECRET_...__")).toBe("__WPI_SECRET_...__");
  });

  it("prevents literal shell interpolation from changing command syntax", () => {
    const redactor = new SecretRedactor();
    const safe = redactor.registerSecret(secret);
    expect(redactor.restore({ command: `curl -H 'Bearer ${safe}'` }, true)).toEqual({ command: `curl -H 'Bearer ${secret}'` });
    const unsafe = redactor.registerSecret("secret'$(echo unsafe)");
    expect(() => redactor.restore({ command: `echo '${unsafe}'` }, true)).toThrow("shell syntax");
    expect(redactor.restore({ command: 'echo "$MY_PASSWORD"' }, true)).toEqual({ command: 'echo "$MY_PASSWORD"' });
    expect(redactor.restore({ password: unsafe })).toEqual({ password: "secret'$(echo unsafe)" });
  });
});

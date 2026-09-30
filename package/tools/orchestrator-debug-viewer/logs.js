/* Shared pure log parsing/model code. No DOM, network, or filesystem access. */
(function (root) {
  "use strict";
  const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const text = (value, fallback = "") => typeof value === "string" ? value : fallback;
  const timestamp = record => {
    const parsed = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  function parse(files) {
    const records = [], warnings = [], seen = new Set();
    let duplicates = 0;
    for (const file of files) {
      const lines = file.text.split(/\r?\n/);
      let invalid = 0;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index].trim();
        if (!line) continue;
        try {
          if (line.length > 512 * 1024) throw new Error("Oversized record");
          const record = JSON.parse(line);
          if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.event !== "string") throw new Error("Not a debug record");
          const key = JSON.stringify(record);
          if (seen.has(key)) { duplicates++; continue; }
          seen.add(key);
          records.push({ ...record, sourceFile: file.name, sourceLine: index + 1 });
        } catch { invalid++; }
      }
      if (invalid) warnings.push(`${file.name}: skipped ${invalid} malformed/incomplete line${invalid === 1 ? "" : "s"}.`);
    }
    records.sort((a, b) => timestamp(a) - timestamp(b));
    return { records, warnings, duplicates };
  }
  function group(records) {
    const byCall = new Map();
    const byRequest = new Map();
    for (const record of records) {
      if (typeof record.requestId === "string") {
        const list = byRequest.get(record.requestId) || [];
        list.push(record);
        byRequest.set(record.requestId, list);
      }
      if (typeof record.callId !== "string") continue;
      const call = byCall.get(record.callId) || { id: record.callId, events: [] };
      call.events.push(record);
      byCall.set(record.callId, call);
    }
    return [...byCall.values()].map(call => {
      const start = call.events.find(record => record.event === "decision_start");
      const end = [...call.events].reverse().find(record => record.event === "decision_end");
      const metadata = start || end || call.events[0];
      const requestId = text(metadata.requestId, text(call.events.find(record => typeof record.requestId === "string")?.requestId));
      const requestEvents = (byRequest.get(requestId) || []).filter(record => !record.callId);
      const httpRequest = call.events.find(record => record.event === "http_request");
      const httpResponse = [...call.events].reverse().find(record => record.event === "http_response");
      const metrics = end?.metrics || {};
      const request = start?.input?.text ?? start?.input?.request ?? httpRequest?.data?.state?.request ?? "";
      const truncated = call.events.some(record => record.event === "truncated_record" || record.data?.omittedOversizedBody);
      const outcome = text(end?.outcome, truncated ? "truncated" : "incomplete");
      const status = end?.status === "error" || end?.error ? "error" : end ? "ok" : "incomplete";
      const duration = number(metrics.durationMs);
      const model = text(httpRequest?.model, text(httpResponse?.model, "Not reported"));
      return { ...call, requestId, requestEvents, start, end, httpRequest, httpResponse, request: typeof request === "string" ? request : JSON.stringify(request),
        kind: text(metadata.kind, text(call.events.find(record => typeof record.kind === "string")?.kind, "unknown")), status, outcome, model,
        time: timestamp(start || end || call.events[0]), timestamp: text((start || end || call.events[0]).timestamp, "Unknown time"),
        sessionId: text(metadata.sessionId), virtualId: text(metadata.virtualId), duration,
        inputTokens: number(metrics.inputTokens), outputTokens: number(metrics.outputTokens),
        outputTps: number(metrics.outputTokensPerSecond), totalTps: number(metrics.totalTokensPerSecond), truncated,
        search: JSON.stringify([call.events, requestEvents]).toLocaleLowerCase(),
      };
    }).sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
  }
  function filter(calls, query, kind, status) {
    const needle = query.trim().toLocaleLowerCase();
    return calls.filter(call => (!needle || call.search.includes(needle)) &&
      (!kind || call.kind === kind) && (!status || call.status === status));
  }
  function stats(calls) {
    const durations = calls.map(call => call.duration).filter(value => value !== null).sort((a, b) => a - b);
    const sum = field => {
      const values = calls.map(call => call[field]).filter(value => value !== null);
      return { value: values.length ? values.reduce((a, b) => a + b, 0) : null, known: values.length, total: calls.length };
    };
    return { calls: calls.length, errors: calls.filter(call => call.status === "error").length,
      incomplete: calls.filter(call => call.status === "incomplete").length,
      medianDuration: durations.length ? (durations[Math.floor((durations.length - 1) / 2)] + durations[Math.floor(durations.length / 2)]) / 2 : null,
      inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens") };
  }
  root.OrchestratorDebugLogs = { parse, group, filter, stats };
})(globalThis);

/* Local-only UI. Log content is untrusted: render exclusively with textContent. */
(function () {
  "use strict";
  const model = globalThis.OrchestratorDebugLogs;
  const $ = id => document.getElementById(id);
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const fmt = value => value === null || value === undefined ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
  const duration = value => value === null ? "—" : value < 1000 ? `${fmt(value)} ms` : `${fmt(value / 1000)} s`;
  const pretty = value => value === undefined ? "Not available in this log." : JSON.stringify(value, null, 2);
  const when = value => { const time = new Date(typeof value === "string" ? value : NaN); return Number.isFinite(time.getTime()) ? time.toLocaleString() : "Unknown time"; };
  const eventTime = event => typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp)) ? Date.parse(event.timestamp) : 0;
  let files = [], records = [], calls = [], selected = null, tab = "summary", loading = false;

  function metric(label, value, note) {
    const node = el("div", undefined, "metric");
    node.append(el("span", label, "metric-label"), el("strong", value));
    if (note) node.append(el("small", note));
    return node;
  }
  function block(title, value) {
    const node = el("section", undefined, "block");
    node.append(el("h3", title), el("pre", typeof value === "string" ? value : pretty(value)));
    return node;
  }
  function button(text, action, className) {
    const node = el("button", text, className);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }
  function outcome(call) {
    const decision = call.end?.effectiveDecision || call.end?.backendResult?.decision;
    return typeof decision?.action === "string" ? `${decision.action}${typeof decision.realId === "string" ? ` → ${decision.realId.slice(0, 8)}` : ""}` : call.outcome.replaceAll("_", " ");
  }
  function render() {
    const filtered = model.filter(calls, $("search").value, $("kind").value, $("status").value);
    const stats = model.stats(filtered);
    $("stats").replaceChildren(
      metric("Decisions", fmt(stats.calls), `${stats.incomplete} incomplete`),
      metric("Errors / fallbacks", fmt(stats.errors)),
      metric("Median latency", duration(stats.medianDuration), "Measured calls only"),
      metric("Input tokens", fmt(stats.inputTokens.value), `${stats.inputTokens.known}/${stats.inputTokens.total} counts known`),
      metric("Output tokens", fmt(stats.outputTokens.value), `${stats.outputTokens.known}/${stats.outputTokens.total} counts known`),
    );
    $("count").textContent = `${filtered.length} of ${calls.length} decisions`;
    const list = $("calls");
    list.replaceChildren();
    if (!filtered.length) list.append(el("p", calls.length ? "No decisions match these filters." : records.length ? "No decision calls in these files. Control/dispatch events are still available below." : "No logs loaded yet.", "empty-list"));
    for (const call of filtered.slice(0, 300)) {
      const card = button("", () => { selected = call.id; render(); }, `call ${selected === call.id ? "selected" : ""}`);
      card.setAttribute("aria-pressed", String(selected === call.id));
      const top = el("div", undefined, "call-top");
      top.append(el("span", call.kind, `badge ${call.kind}`), el("span", call.status, `badge ${call.status}`), el("time", when(call.timestamp)));
      card.append(top, el("strong", outcome(call), "call-outcome"), el("p", call.request || "Request unavailable (partial log)", "request-preview"));
      card.append(el("div", `${call.model} · ${duration(call.duration)} · ${fmt(call.outputTps)} output tok/s`, "call-meta"));
      list.append(card);
    }
    if (filtered.length > 300) list.append(el("p", "Showing the newest 300 matches. Use search or filters to narrow the list.", "empty-list"));
    if (records.length) {
      const standalone = records.filter(record => !record.callId);
      const details = el("details", undefined, "workspace-events");
      details.append(el("summary", `Control / dispatch events (${standalone.length})`));
      for (const record of standalone.slice(-100).reverse()) details.append(block(`${when(record.timestamp)} · ${record.event}`, record));
      if (standalone.length > 100) details.append(el("p", "Showing the newest 100 control/dispatch events."));
      list.append(details);
    }
    renderDetail();
  }
  function renderDetail() {
    const call = calls.find(item => item.id === selected);
    $("detail-empty").hidden = !!call;
    const panel = $("detail");
    panel.hidden = !call;
    panel.replaceChildren();
    if (!call) return;
    const heading = el("div", undefined, "detail-heading");
    heading.append(el("p", `${call.kind.toUpperCase()} / ${call.status.toUpperCase()}`, "eyebrow"), el("h2", outcome(call)), el("p", `${when(call.timestamp)} · ${call.model}`, "muted"));
    panel.append(heading);
    if (call.truncated || call.status === "incomplete") panel.append(el("p", "This call has truncated or incomplete records. Missing details/metrics are not zero.", "warning"));
    const metrics = el("div", undefined, "detail-metrics");
    metrics.append(metric("Latency", duration(call.duration)), metric("Input", fmt(call.inputTokens)), metric("Output", fmt(call.outputTokens)), metric("Output tok/s", fmt(call.outputTps)), metric("Total tok/s", fmt(call.totalTps)));
    panel.append(metrics);
    const tabs = el("nav", undefined, "tabs");
    tabs.setAttribute("aria-label", "Decision detail views");
    for (const [id, label] of [["summary", "Overview"], ["input", "Request"], ["response", "Response"], ["timeline", "Timeline"], ["raw", "Raw records"]]) {
      const node = button(label, () => { tab = id; renderDetail(); }, tab === id ? "active" : "");
      node.setAttribute("aria-pressed", String(tab === id));
      tabs.append(node);
    }
    panel.append(tabs);
    if (tab === "summary") {
      const ids = el("dl", undefined, "identifiers");
      for (const [label, value] of [["Call", call.id], ["Request", call.requestId], ["Virtual session", call.virtualId], ["Real session", call.sessionId], ["Endpoint", typeof call.httpRequest?.endpoint === "string" ? call.httpRequest.endpoint : undefined]]) ids.append(el("dt", label), el("dd", value || "—"));
      panel.append(ids, block("Original request", call.request || "Not available in this snapshot."));
      if (call.end?.error) panel.append(block("Error", call.end.error));
      panel.append(block("Controller outcome", { outcome: call.end?.outcome, effectiveDecision: call.end?.effectiveDecision, result: call.end?.result, backendResult: call.end?.backendResult, backendCalled: call.end?.backendCalled }));
      panel.append(block("Usage and timing", { metrics: call.end?.metrics, usage: call.end?.usage }));
      const related = calls.filter(other => other.id !== call.id && call.requestId && other.requestId === call.requestId);
      if (related.length) {
        const section = el("section", undefined, "block");
        section.append(el("h3", "Other decisions for this request"));
        for (const other of related) section.append(button(`${other.kind}: ${outcome(other)}`, () => { selected = other.id; render(); }, "related"));
        panel.append(section);
      }
    } else if (tab === "input") {
      panel.append(block("Actual backend request", call.httpRequest?.data), block("Controller input / candidates", call.start?.input));
    } else if (tab === "response") {
      panel.append(block("Actual backend response", call.httpResponse ? { httpStatus: call.httpResponse.httpStatus, durationMs: call.httpResponse.durationMs, data: call.httpResponse.data } : undefined), block("Parsed result / effective outcome", call.end));
    } else if (tab === "timeline") {
      const timeline = [...call.events, ...call.requestEvents].sort((a, b) => eventTime(a) - eventTime(b));
      for (const event of timeline) {
        const node = el("details", undefined, "timeline-event");
        node.append(el("summary", `${when(event.timestamp)} · ${event.event}${typeof event.httpStatus === "number" ? ` · HTTP ${event.httpStatus}` : ""}`), el("pre", pretty(event)));
        panel.append(node);
      }
    } else panel.append(block("Call records", call.events), block("Related request events", call.requestEvents));
  }
  async function load(nextFiles) {
    if (loading || !nextFiles.length) return;
    if (nextFiles.length > 20 || nextFiles.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024) {
      $("notice").textContent = "Choose at most 20 files, totalling no more than 50 MiB.";
      return;
    }
    loading = true;
    $("load").disabled = $("reload").disabled = $("clear").disabled = true;
    $("notice").textContent = "Reading local files…";
    try {
      const input = await Promise.all(nextFiles.map(async file => ({ name: file.name, text: await file.text() })));
      const parsed = model.parse(input);
      files = nextFiles;
      records = parsed.records;
      calls = model.group(records);
      if (!calls.some(call => call.id === selected)) selected = calls[0]?.id || null;
      $("file-label").textContent = `${files.map(file => file.name).join(", ")} · ${records.length} records`;
      $("notice").textContent = [...parsed.warnings, ...(parsed.duplicates ? [`${parsed.duplicates} overlapping records deduplicated.`] : []), ...(!records.length ? ["No valid debug records found."] : [])].join(" ");
      render();
    } catch {
      $("notice").textContent = "Could not read the files. Re-open them if they changed or rotated. Previously loaded data has been kept.";
    } finally {
      loading = false;
      $("load").disabled = false;
      $("reload").disabled = $("clear").disabled = !files.length;
    }
  }
  $("load").addEventListener("click", () => { $("files").value = ""; $("files").click(); });
  $("files").addEventListener("change", event => load([...event.target.files]));
  $("reload").addEventListener("click", () => load(files));
  $("clear").addEventListener("click", () => {
    files = []; records = []; calls = []; selected = null;
    $("files").value = ""; $("notice").textContent = "";
    $("file-label").textContent = "Drop JSONL logs here, or choose Open logs.";
    $("reload").disabled = $("clear").disabled = true;
    render();
  });
  for (const id of ["search", "kind", "status"]) $(id).addEventListener("input", render);
  for (const event of ["dragenter", "dragover"]) $("drop").addEventListener(event, e => { e.preventDefault(); $("drop").classList.add("dragging"); });
  $("drop").addEventListener("dragleave", () => $("drop").classList.remove("dragging"));
  $("drop").addEventListener("drop", event => { event.preventDefault(); $("drop").classList.remove("dragging"); load([...event.dataTransfer.files]); });
  // Prevent accidental navigation away from the viewer when dropping outside the zone.
  document.addEventListener("dragover", event => event.preventDefault());
  document.addEventListener("drop", event => event.preventDefault());
  render();
})();

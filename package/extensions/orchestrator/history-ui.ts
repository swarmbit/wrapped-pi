import { InteractiveMode, type SessionContext, type SessionEntry, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type Manager = ExtensionContext["sessionManager"];
type Projection = (manager: Manager, original: SessionContext) => SessionContext;
interface ChatMode {
  ui: object;
  sessionManager: Manager;
  rebuildChatFromMessages(): void;
  renderInitialMessages?(): void;
  renderSessionContext?(context: SessionContext, options?: unknown): void;
  renderSessionEntries?(entries: SessionEntry[], options?: unknown): void;
  renderSessionItems?(items: SessionContext["messages"], options?: unknown): void;
}
interface Adapter {
  modes: WeakMap<object, ChatMode>;
  projections: WeakMap<object, Projection>;
}
const KEY = Symbol.for("wpi.orchestrator.chat-history-adapter.v2");
type Prototype = ChatMode & { [KEY]?: Adapter };

function installAdapter(prototype: Prototype | undefined): Adapter | undefined {
  if (!prototype || typeof prototype.rebuildChatFromMessages !== "function") return undefined;
  if (prototype[KEY]) return prototype[KEY];
  const legacy = typeof prototype.renderSessionContext === "function";
  if (!legacy && (typeof prototype.renderSessionEntries !== "function" ||
      typeof prototype.renderSessionItems !== "function" ||
      typeof prototype.renderInitialMessages !== "function")) return undefined;
  const shared: Adapter = { modes: new WeakMap(), projections: new WeakMap() };
  Object.defineProperty(prototype, KEY, { value: shared });
  const project = (mode: ChatMode, context: SessionContext) => {
    shared.modes.set(mode.ui, mode);
    try { return shared.projections.get(mode.ui)?.(mode.sessionManager, context) ?? context; }
    catch (error) {
      console.error("Orchestrator history projection failed; showing real-session chat.", error);
      return context;
    }
  };
  if (legacy) {
    const original = prototype.renderSessionContext!;
    prototype.renderSessionContext = function(context, options) {
      return original.call(this, project(this, context), options);
    };
  } else {
    // Pi 0.99.1 renders entries, not SessionContext. Only replace full-chat
    // renders: compaction also renders entry slices incrementally, and projecting
    // those would append the entire virtual history more than once.
    const fullRenders = new WeakSet<ChatMode>();
    for (const name of ["renderInitialMessages", "rebuildChatFromMessages"] as const) {
      const original = prototype[name]!;
      prototype[name] = function() {
        shared.modes.set(this.ui, this);
        const nested = fullRenders.has(this);
        fullRenders.add(this);
        try { return original.call(this); }
        finally { if (!nested) fullRenders.delete(this); }
      };
    }
    const original = prototype.renderSessionEntries!;
    prototype.renderSessionEntries = function(entries, options) {
      if (fullRenders.has(this) && shared.projections.has(this.ui)) {
        // The projection only uses original as the disabled/fallback sentinel;
        // do not build or modify the real session's model context here.
        const context: SessionContext = { messages: [], thinkingLevel: "off", model: null };
        const display = project(this, context);
        if (display !== context) return this.renderSessionItems!(display.messages, options);
      }
      return original.call(this, entries, options);
    };
  }
  return shared;
}

// Observe the initial native render before routing is enabled, so binding can
// immediately rebuild an already displayed session. WeakMaps do not retain TUIs.
installAdapter(InteractiveMode?.prototype as unknown as Prototype);

/** Display-only compatibility adapter for Pi 0.79.1 and 0.99.1. */
export function bindChatHistory(tui: object, projection: Projection,
  prototype = InteractiveMode?.prototype as unknown as Prototype):
  { refresh(): void; dispose(refresh?: boolean): void } | undefined {
  const shared = installAdapter(prototype);
  if (!shared) return undefined;
  shared.projections.set(tui, projection);
  const refresh = () => shared.modes.get(tui)?.rebuildChatFromMessages();
  refresh();
  return {
    refresh,
    dispose: (rebuild = false) => {
      if (shared.projections.get(tui) !== projection) return;
      shared.projections.delete(tui);
      if (rebuild) refresh();
    },
  };
}

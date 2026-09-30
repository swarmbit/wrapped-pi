import { InteractiveMode, type SessionContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type Manager = ExtensionContext["sessionManager"];
type Projection = (manager: Manager, original: SessionContext) => SessionContext;
interface ChatMode {
  ui: object;
  sessionManager: Manager;
  rebuildChatFromMessages(): void;
  renderSessionContext(context: SessionContext, options?: unknown): void;
}
interface Adapter {
  modes: WeakMap<object, ChatMode>;
  projections: WeakMap<object, Projection>;
}
const KEY = Symbol.for("wpi.orchestrator.chat-history-adapter.v1");

/**
 * Pi 0.79.1 compatibility adapter: replace ONLY the argument to the native chat
 * renderer. Never patch SessionManager, model messages, or transcript files.
 * Symbol/WeakMaps keep a single wrapper across extension reloads and isolate TUIs.
 */
export function bindChatHistory(tui: object, projection: Projection,
  prototype = InteractiveMode?.prototype as unknown as ChatMode & { [KEY]?: Adapter }):
  { refresh(): void; dispose(refresh?: boolean): void } | undefined {
  if (!prototype || typeof prototype.renderSessionContext !== "function" ||
      typeof prototype.rebuildChatFromMessages !== "function") return undefined;
  let adapter = prototype[KEY];
  if (!adapter) {
    adapter = { modes: new WeakMap(), projections: new WeakMap() };
    Object.defineProperty(prototype, KEY, { value: adapter });
    const original = prototype.renderSessionContext;
    const shared = adapter;
    prototype.renderSessionContext = function(context, options) {
      shared.modes.set(this.ui, this);
      const project = shared.projections.get(this.ui);
      // A missing/corrupt member must not prevent native chat from rendering.
      let display = context;
      if (project) {
        try { display = project(this.sessionManager, context); }
        catch (error) { console.error("Orchestrator history projection failed; showing real-session chat.", error); }
      }
      return original.call(this, display, options);
    };
  }
  adapter.projections.set(tui, projection);
  const shared = adapter;
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

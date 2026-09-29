import type { EditorComponent } from "@earendil-works/pi-tui";

export function isOrdinarySubmission(text: string): boolean {
  const value = text.trimStart();
  return !!value.trim() && !value.startsWith("/") && !value.startsWith("!");
}

/**
 * Preserve the actual editor's prototype and capabilities, binding methods to
 * it (important for private fields). Pi assigns onSubmit AFTER factory creation.
 * An accessor on the proxy keeps the routing wrapper installed on the base too.
 */
export function decorateEditor(
  base: EditorComponent,
  transform: (text: string) => string,
  originalHistoryText: (text: string) => string = text => text,
): EditorComponent {
  let hostSubmit = base.onSubmit;
  const submit = (text: string) => hostSubmit?.(transform(text));
  base.onSubmit = submit;
  const methods = new Map<PropertyKey, { original: unknown; bound: unknown }>();
  return new Proxy(base, {
    get(target, key) {
      if (key === "onSubmit") return submit;
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      const cached = methods.get(key);
      if (cached && cached.original === value) return cached.bound;
      const bound = key === "addToHistory"
        ? (text: string) => value.call(target, originalHistoryText(text))
        : value.bind(target);
      methods.set(key, { original: value, bound });
      return bound;
    },
    set(target, key, value) {
      if (key === "onSubmit") {
        hostSubmit = value;
        target.onSubmit = submit;
        return true;
      }
      return Reflect.set(target, key, value, target);
    },
  });
}

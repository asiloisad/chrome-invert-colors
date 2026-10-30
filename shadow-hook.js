(() => {
  "use strict";

  // Runs in MAIN solely to observe roots created after a host was inserted.
  // No extension data or Chrome APIs cross the page/content-script boundary.
  const key = Symbol.for("invert-colors.shadow-hook.v1");
  if (globalThis[key]) return;
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow");
  if (!descriptor?.value || !descriptor.configurable) return;
  const original = descriptor.value;
  const dispatchEvent = EventTarget.prototype.dispatchEvent;
  const ShadowEvent = Event;
  function attachShadow(init) {
    const root = Reflect.apply(original, this, [init]);
    if (root.mode === "open") {
      Reflect.apply(dispatchEvent, this, [new ShadowEvent("__invert_colors_open_shadow_v1__", {
        bubbles: true,
        composed: true,
      })]);
    }
    return root;
  }
  try {
    Object.defineProperty(Element.prototype, "attachShadow", { ...descriptor, value: attachShadow });
    globalThis[key] = true;
  } catch {
    // Existing roots and inserted hosts are still discovered by the content script.
  }
})();

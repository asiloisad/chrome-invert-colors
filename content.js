(() => {
  "use strict";

  const INSTANCE_KEY = Symbol.for("invert-colors.content.v1");
  const SHADOW_EVENT = "__invert_colors_open_shadow_v1__";
  const existing = globalThis[INSTANCE_KEY];
  if (existing) {
    try {
      existing.dispose();
    } catch {
      // A previous extension version may have an invalid runtime context.
    }
  }

  const DEFAULT_MEDIA = Object.freeze({
    images: true,
    video: true,
    canvas: true,
    svg: false,
    backgrounds: false,
  });
  const managed = new Map();
  const candidates = new Set();
  const observedRoots = new Map();
  const ownStyleSnapshots = new WeakMap();
  const pendingSubtrees = new Set();
  const pendingElements = new Set();
  let state = {
    enabled: false,
    mode: "off",
    temporary: false,
    topFrame: window === window.top,
    media: { ...DEFAULT_MEDIA },
    revision: -1,
  };
  let fullScan = true;
  let refreshFilters = true;
  let flushTimer = null;
  let disposed = false;

  function normalizeState(value) {
    if (!value || typeof value !== "object") return null;
    const revision = Number.isFinite(value.revision) ? value.revision : state.revision;
    if (revision < state.revision) return null;
    const media = { ...DEFAULT_MEDIA };
    for (const key of Object.keys(media)) {
      if (typeof value.media?.[key] === "boolean") media[key] = value.media[key];
    }
    return {
      enabled: value.enabled !== false,
      mode: ["media", "page", "off"].includes(value.mode) ? value.mode : "media",
      temporary: value.temporary === true,
      topFrame: typeof value.topFrame === "boolean" ? value.topFrame : window === window.top,
      media,
      revision,
    };
  }

  function applyState(value) {
    const next = normalizeState(value);
    if (!next) return;
    const { revision: _previousRevision, ...previousAppearance } = state;
    const { revision: _nextRevision, ...nextAppearance } = next;
    state = next;
    if (JSON.stringify(previousAppearance) !== JSON.stringify(nextAppearance)) {
      fullScan = true;
      refreshFilters = true;
      scheduleFlush();
    }
  }

  function requestState() {
    if (disposed) return;
    try {
      chrome.runtime.sendMessage({ type: "GET_FRAME_STATE" }, (response) => {
        if (chrome.runtime.lastError || disposed) return;
        if (response?.ok && response.state) applyState(response.state);
      });
    } catch {
      // An extension update can invalidate a content script before reinjection.
    }
  }

  function composedParent(element) {
    if (element.assignedSlot) return element.assignedSlot;
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }

  function setOriginalFilter(element, record) {
    if (record.originalValue) {
      element.style.setProperty("filter", record.originalValue, record.originalPriority);
    } else {
      element.style.removeProperty("filter");
      if (!record.originalStylePresent && !element.style.length) element.removeAttribute("style");
    }
    ownStyleSnapshots.set(element, element.getAttribute("style"));
  }

  function restoreFilter(element, record) {
    // A framework may have replaced our inline filter since the last mutation.
    if (
      element.style.getPropertyValue("filter") === record.appliedValue &&
      element.style.getPropertyPriority("filter") === "important"
    ) {
      setOriginalFilter(element, record);
    }
    managed.delete(element);
  }

  function invertElement(element, refresh) {
    let record = managed.get(element);
    const currentValue = element.style.getPropertyValue("filter");
    const currentPriority = element.style.getPropertyPriority("filter");
    if (!record) {
      record = {
        originalValue: currentValue,
        originalPriority: currentPriority,
        originalStylePresent: element.hasAttribute("style"),
        appliedValue: "",
      };
      managed.set(element, record);
      refresh = true;
    } else if (currentValue !== record.appliedValue || currentPriority !== "important") {
      record.originalValue = currentValue;
      record.originalPriority = currentPriority;
      record.originalStylePresent = element.hasAttribute("style");
      refresh = true;
    }
    if (!refresh) return;

    setOriginalFilter(element, record);
    const authorFilter = getComputedStyle(element).filter;
    record.appliedValue = authorFilter && authorFilter !== "none"
      ? `${authorFilter} invert(1)`
      : "invert(1)";
    element.style.setProperty("filter", record.appliedValue, "important");
    ownStyleSnapshots.set(element, element.getAttribute("style"));
  }

  function hasGeneratedContent(element, pseudo) {
    const content = getComputedStyle(element, pseudo).content;
    return content && !["none", "normal", '""', "''"].includes(content);
  }

  function isCandidate(element) {
    if (!element.style) return false;
    const tag = element.localName;
    if (tag === "img") return state.media.images;
    if (tag === "video") return state.media.video;
    if (tag === "canvas") return state.media.canvas;
    if (tag === "svg") return state.media.svg;
    if (!state.media.backgrounds) return false;

    // A filter affects the entire element. Only empty background surfaces are
    // safe to compensate without also changing their text or nested controls.
    if (
      element.children.length || element.textContent.trim() || element.shadowRoot ||
      ["html", "body", "iframe", "frame", "object", "embed", "input", "textarea",
        "button", "select", "option", "meter", "progress", "slot"].includes(tag)
    ) return false;
    const background = getComputedStyle(element).backgroundImage;
    if (!background || background === "none") return false;
    // Gradients are page decoration; compensate raster/vector image URLs only.
    if (!/\b(?:url|image-set|-webkit-image-set)\s*\(/i.test(background)) return false;
    return !hasGeneratedContent(element, "::before") && !hasGeneratedContent(element, "::after");
  }

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    const observer = new MutationObserver(onMutations);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "class", "href", "rel", "media", "disabled", "slot", "name"],
    });
    root.addEventListener("slotchange", scheduleFlush, true);
    observedRoots.set(root, observer);
  }

  function inspectElement(element, mediaEnabled, changed) {
    if (!element.isConnected) return;
    if (mediaEnabled && isCandidate(element)) candidates.add(element);
    else candidates.delete(element);
    if (changed) changed.add(element);
    if (element.shadowRoot) {
      observeRoot(element.shadowRoot);
      scanSubtree(element.shadowRoot, mediaEnabled, changed);
    }
  }

  function scanSubtree(root, mediaEnabled, changed) {
    if (root instanceof Element) inspectElement(root, mediaEnabled, changed);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let element;
    while ((element = walker.nextNode())) inspectElement(element, mediaEnabled, changed);
  }

  function enqueueSubtree(root) {
    if (!(root instanceof Element || root instanceof ShadowRoot || root === document)) return;
    pendingSubtrees.add(root);
    scheduleFlush();
  }

  function affectsStylesheet(node) {
    return node instanceof Element && (
      node.localName === "style" ||
      (node.localName === "link" && /\bstylesheet\b/i.test(node.rel))
    );
  }

  function onMutations(mutations) {
    let hasWork = false;
    for (const mutation of mutations) {
      const target = mutation.target;
      if (mutation.type === "attributes") {
        if (
          mutation.attributeName === "style" &&
          ownStyleSnapshots.has(target) &&
          ownStyleSnapshots.get(target) === target.getAttribute("style")
        ) continue;
        if (affectsStylesheet(target)) {
          fullScan = true;
          refreshFilters = true;
        } else {
          pendingSubtrees.add(target);
        }
        hasWork = true;
      } else if (mutation.type === "characterData") {
        if (affectsStylesheet(target.parentElement)) {
          fullScan = true;
          refreshFilters = true;
        } else if (target.parentElement) {
          pendingElements.add(target.parentElement);
        }
        hasWork = true;
      } else {
        if (affectsStylesheet(target)) {
          fullScan = true;
          refreshFilters = true;
        }
        // Inspect the parent as well: inserting children can invalidate a safe
        // background surface. Added subtrees include their open shadow roots.
        if (target instanceof Element) pendingElements.add(target);
        for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
          if (affectsStylesheet(node) || (node instanceof Element && node.querySelector("style, link[rel~=stylesheet]"))) {
            fullScan = true;
            refreshFilters = true;
          }
          if (node instanceof Element && node.isConnected) pendingSubtrees.add(node);
        }
        hasWork = true;
      }
    }
    if (hasWork) scheduleFlush();
  }

  function scheduleFlush() {
    if (disposed || flushTimer !== null) return;
    flushTimer = setTimeout(flush, 0);
  }

  function flush() {
    flushTimer = null;
    if (disposed) return;
    const mediaEnabled = state.enabled && state.mode === "media";
    const pageEnabled = state.enabled && state.topFrame && ((state.mode === "page") !== state.temporary);
    const changed = new Set();

    for (const [root, observer] of observedRoots) {
      if (root instanceof ShadowRoot && !root.host.isConnected) {
        observer.disconnect();
        root.removeEventListener("slotchange", scheduleFlush, true);
        observedRoots.delete(root);
      }
    }
    for (const element of candidates) {
      if (!element.isConnected || !mediaEnabled) candidates.delete(element);
    }
    if (fullScan) {
      candidates.clear();
      scanSubtree(document, mediaEnabled, changed);
    } else {
      // Drop roots already covered by an ancestor in this same batch.
      const roots = [...pendingSubtrees].filter((root) => {
        if (root !== document && !root.isConnected) return false;
        let parent = root instanceof ShadowRoot ? root.host : root.parentNode;
        while (parent) {
          if (pendingSubtrees.has(parent)) return false;
          parent = parent instanceof ShadowRoot ? parent.host : parent.parentNode;
        }
        return true;
      });
      for (const root of roots) scanSubtree(root, mediaEnabled, changed);
      for (const element of pendingElements) inspectElement(element, mediaEnabled, changed);
    }

    const desired = new Set();
    if (mediaEnabled) {
      for (const element of candidates) {
        let parent = composedParent(element);
        let nested = false;
        while (parent) {
          if (candidates.has(parent)) {
            nested = true;
            break;
          }
          parent = composedParent(parent);
        }
        if (!nested) desired.add(element);
      }
    }
    if (pageEnabled && document.documentElement?.style) desired.add(document.documentElement);

    for (const [element, record] of managed) {
      if (!desired.has(element) || !element.isConnected) restoreFilter(element, record);
    }
    for (const element of desired) invertElement(element, refreshFilters || changed.has(element));

    fullScan = false;
    refreshFilters = false;
    pendingSubtrees.clear();
    pendingElements.clear();
  }

  function refresh() {
    fullScan = true;
    refreshFilters = true;
    scheduleFlush();
    requestState();
  }

  function inspectEventPath(event) {
    for (const node of event.composedPath()) {
      if (node instanceof Element && node.shadowRoot) {
        observeRoot(node.shadowRoot);
        enqueueSubtree(node.shadowRoot);
      }
    }
  }

  function onLoad(event) {
    if (event.target === document || affectsStylesheet(event.target)) {
      fullScan = true;
      refreshFilters = true;
      scheduleFlush();
    }
    inspectEventPath(event);
  }

  function onVisibilityChange() {
    if (document.visibilityState === "visible") refresh();
  }

  function onMessage(message, _sender, sendResponse) {
    if (message?.type !== "APPLY_STATE") return;
    applyState(message.state);
    sendResponse({ ok: true });
  }

  function dispose() {
    disposed = true;
    if (flushTimer !== null) clearTimeout(flushTimer);
    for (const [root, observer] of observedRoots) {
      observer.disconnect();
      root.removeEventListener("slotchange", scheduleFlush, true);
    }
    observedRoots.clear();
    for (const [element, record] of managed) restoreFilter(element, record);
    candidates.clear();
    pendingSubtrees.clear();
    pendingElements.clear();
    document.removeEventListener(SHADOW_EVENT, inspectEventPath, true);
    document.removeEventListener("pointerdown", inspectEventPath, true);
    document.removeEventListener("focusin", inspectEventPath, true);
    document.removeEventListener("load", onLoad, true);
    document.removeEventListener("DOMContentLoaded", refresh);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pageshow", refresh);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // Cleanup of observers and styles still succeeds after an update.
    }
    delete globalThis[INSTANCE_KEY];
  }

  globalThis[INSTANCE_KEY] = { refresh, dispose };
  observeRoot(document);
  document.addEventListener(SHADOW_EVENT, inspectEventPath, true);
  document.addEventListener("pointerdown", inspectEventPath, true);
  document.addEventListener("focusin", inspectEventPath, true);
  document.addEventListener("load", onLoad, true);
  document.addEventListener("DOMContentLoaded", refresh);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pageshow", refresh);
  chrome.runtime.onMessage.addListener(onMessage);
  scheduleFlush();
  requestState();
})();

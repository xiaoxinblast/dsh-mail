import React, { useLayoutEffect, useEffect, useRef, useState } from "react";
import { App } from "./workbench.jsx";
import presentationCss from "./presentation.css";

let surfaceSequence = 0;
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function retainInteraction(surface) {
  const focus = surface.contains(document.activeElement) ? document.activeElement : null;
  const ranges = [], selection = document.getSelection();
  if (selection) for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    if (surface.contains(range.commonAncestorContainer)) ranges.push(range.cloneRange());
  }
  const input = focus && typeof focus.selectionStart === "number" ? { start: focus.selectionStart, end: focus.selectionEnd, direction: focus.selectionDirection } : null;
  const scrolls = [surface, ...surface.querySelectorAll("*")].filter((element) => element.scrollTop || element.scrollLeft).map((element) => ({ element, top: element.scrollTop, left: element.scrollLeft }));
  const restoreScroll = () => { for (const { element, top, left } of scrolls) if (element.isConnected) { element.scrollTop = top; element.scrollLeft = left; } };
  const restore = () => {
    if (focus?.isConnected) focus.focus({ preventScroll: true });
    if (input && focus?.isConnected) focus.setSelectionRange(input.start, input.end, input.direction);
    if (!input && ranges.length && selection) { try { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); } catch {} }
    restoreScroll();
  };
  restore.scroll = restoreScroll;
  return restore;
}

// One connected dialog root renders in the sidebar normally and enters the
// browser top layer for workspace fullscreen. Its iframe/editor tree never moves.
export function createMailPresentationHost() {
  const surfaces = new Map();
  let active = null, transition = null, busy = false;
  const notify = (record, fullscreen, transitioning = false) => record?.onChange({ fullscreen, transitioning });
  const restore = (id, notifyOwner = true) => {
    const record = surfaces.get(id);
    if (!record || active !== id) return;
    const interaction = retainInteraction(record.surface);
    record.surface.close();
    delete record.surface.dataset.workspaceFullscreen;
    record.surface.open = true;
    active = null;
    if (notifyOwner) notify(record, false, busy);
    interaction();
    return interaction;
  };
  const change = (record, update) => {
    busy = true;
    const noMotion = reducedMotion() || record.surface.querySelector(".dm-app")?.dataset.motion === "off";
    let interaction;
    const perform = () => { interaction = update(); };
    notify(record, active === record.id, true);
    const name = record.surface.style.viewTransitionName;
    const rules = document.createElement("style");
    rules.textContent = `::view-transition-group(${name}){animation-duration:180ms;animation-timing-function:cubic-bezier(.2,.7,.2,1)}::view-transition-old(${name}),::view-transition-new(${name}){animation-duration:180ms}html[data-dm-mail-transition]::view-transition-group(root),html[data-dm-mail-transition]::view-transition-old(root),html[data-dm-mail-transition]::view-transition-new(root){animation:none}`;
    const finish = () => { interaction?.scroll(); rules.remove(); delete document.documentElement.dataset.dmMailTransition; transition = null; busy = false; notify(surfaces.get(record.id), active === record.id); };
    if (!noMotion && typeof document.startViewTransition === "function") {
      document.documentElement.dataset.dmMailTransition = name;
      document.head.appendChild(rules);
      try {
        transition = document.startViewTransition(perform);
        transition.ready.catch(() => {});
        transition.finished.catch(() => {}).finally(finish);
        return;
      } catch {}
    }
    perform();
    if (!noMotion && typeof record.surface.animate === "function") {
      const animation = record.surface.animate([{ opacity: .85 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
      animation.finished.catch(() => {}).finally(finish);
    } else finish();
  };
  return {
    register(record) {
      surfaces.set(record.id, record);
      return () => { transition?.skipTransition(); if (active === record.id) { record.surface.close(); active = null; } surfaces.delete(record.id); };
    },
    toggle(id) {
      const record = surfaces.get(id);
      if (!record || busy) return;
      if (active === id) { change(record, () => restore(id)); return; }
      if (active) restore(active);
      const interaction = retainInteraction(record.surface);
      change(record, () => {
        record.surface.close();
        record.surface.dataset.workspaceFullscreen = "true";
        record.surface.showModal();
        active = id;
        notify(record, true, true);
        interaction();
        return interaction;
      });
    },
    exit(id, animate = false) {
      if (active !== id) return;
      transition?.skipTransition();
      const record = surfaces.get(id);
      if (animate && !busy && record) change(record, () => restore(id)); else restore(id);
    },
    dismiss() { if (active && !busy) this.exit(active, true); },
    dispose() { transition?.skipTransition(); if (active) restore(active, false); surfaces.clear(); }
  };
}

export function MailFullscreenLayer() { return <style>{presentationCss}</style>; }

export function MailSurface({ presentationHost, origin = "main", ...props }) {
  const root = useRef(null), [id] = useState(() => `dm-mail-surface-${++surfaceSequence}`);
  const [presentation, setPresentation] = useState({ fullscreen: false, transitioning: false });
  useLayoutEffect(() => presentationHost.register({ id, surface: root.current, onChange: setPresentation }), [presentationHost, id]);
  useEffect(() => { if (props.visible === false) presentationHost.exit(id); }, [props.visible, presentationHost, id]);
  return <dialog ref={root} open className="dm-live-surface dm-workspace-fullscreen" role={presentation.fullscreen ? "dialog" : "group"} aria-modal={presentation.fullscreen || undefined} aria-label={presentation.fullscreen ? "DSH Mail 全屏工作区" : "DSH Mail 工作区"} data-mail-origin={origin} data-mail-visible={props.visible === false ? undefined : "true"} style={{ viewTransitionName: id }} onCancel={(event) => { event.preventDefault(); presentationHost.dismiss(); }}><App {...props} presentation={{ ...presentation, origin, toggle: () => presentationHost.toggle(id) }} /></dialog>;
}

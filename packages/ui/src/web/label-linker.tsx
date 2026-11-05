"use client";
/**
 * Links every form label to the box next to it, on every page.
 *
 * Most of our forms are written as <label>Name</label><input …/>. That looks right, but the browser doesn't know
 * the two belong together: tapping the label does not put the cursor in the box, and screen readers read the box
 * without its name. Instead of adding an id to ~200 boxes by hand, this watches the page and, for each label that
 * has no "for" and no box inside it, connects it to the first box that follows it.
 */
import { useEffect } from "react";

const FIELD = "input:not([type=hidden]), select, textarea";
let seq = 0;

function link(root: ParentNode) {
  root.querySelectorAll("label:not([for])").forEach((label) => {
    if (label.querySelector(FIELD)) return; // the box is inside the label: already linked
    const next = label.nextElementSibling;
    const field = next && next.matches(FIELD) ? next : null;
    if (!field) return;
    if (!field.id) field.id = `qcs-f${++seq}`;
    label.setAttribute("for", field.id);
  });
}

export function LabelLinker() {
  useEffect(() => {
    link(document);
    let queued = false;
    const obs = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; link(document); });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);
  return null;
}

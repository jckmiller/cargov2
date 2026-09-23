// Pointer + keyboard interaction: select, drag (settles at the lowest legal
// rest — the floor when free, otherwise on top of legal supports), Shift-click
// to build a multi-selection, rotate (R), tip (T), delete, dbl-click details.
//
// Multi-select + move-as-one: Shift-click toggles items in/out of a selection
// set. Plain-dragging any member of the set translates the whole set as a rigid
// group — every member keeps its relative position and height so the group
// moves as one, validated all-or-nothing against non-selected items. Delete and
// the nudge pad/arrow keys act on the whole set; rotate/tip/edit/details act on
// the primary (last-clicked) item.
import * as THREE from 'three';
import { activeScenario, catalogItem } from './store.js';
import { collidesAny, canStack, overlapsXZ, isFullySupported, COLLISION_EPS, snapToGrid, layoutError, fitAtSpot } from './cargo.js';
import { toast } from './ui.js';

export class Interaction {
  constructor(sceneMgr, callbacks) {
    this.sm = sceneMgr;
    // callbacks: { onSelect(id,{toggle}), onChange, onEdit, onDetails, onDelete,
    //   onToggleLabels, onTogglePending, onToggleSnap, onToggleOpenings,
    //   getContainerSpec,
    //   getSelectedId, getSelectedIds, getSnapEnabled }
    this.cb = callbacks;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.dragging = null; // { placement, group, offset }
    this.dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    const dom = this.sm.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => this.onDown(e));
    dom.addEventListener('pointermove', (e) => this.onMove(e));
    dom.addEventListener('pointerup', (e) => this.onUp(e));
    dom.addEventListener('pointercancel', () => this.onUp());
    dom.addEventListener('lostpointercapture', () => this.onUp());
    dom.addEventListener('dblclick', (e) => this.onDblClick(e));
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** True unless the caller restricts the session to view-only (Viewer role). */
  editAllowed() {
    return !this.cb.canEdit || this.cb.canEdit();
  }

  setPointer(e) {
    const rect = this.sm.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  pickPlacement() {
    this.raycaster.setFromCamera(this.pointer, this.sm.camera);
    const hits = this.raycaster.intersectObjects(this.sm.cargoGroup.children, true);
    for (const h of hits) {
      let o = h.object;
      while (o && !o.userData.placementId) o = o.parent;
      if (o && o.userData.placementId) return o;
    }
    return null;
  }

  onDown(e) {
    if (this.cb.isMeasuring && this.cb.isMeasuring()) return; // Measure tool owns the canvas
    if (e.button !== 0 || e.ctrlKey || e.metaKey) return; // plain left = drag; Ctrl/Cmd+left = orbit
    this.setPointer(e);
    const group = this.pickPlacement();
    if (!group) {
      // Empty space: Shift-click keeps the current set (avoids accidental
      // clears while building a selection); a plain click clears it.
      if (!e.shiftKey) this.cb.onSelect(null);
      return;
    }
    const id = group.userData.placementId;
    const scenario = activeScenario();
    const placement = scenario?.placements.find((p) => p.id === id);
    if (!placement) return;

    // View-only mode: allow click/Shift-click selection (for clearances and
    // item details) but never begin a drag.
    if (!this.editAllowed()) {
      this.cb.onSelect(id, { toggle: e.shiftKey });
      return;
    }

    this.sm.renderer.domElement.setPointerCapture(e.pointerId);

    const currentSet = this.getSelectedIds();
    const inMultiSelection = currentSet.length > 1 && currentSet.includes(id);

    // Shift decides between two actions based on whether the user drags:
    //   • Shift+click (no movement) → toggle this item in/out of the selection.
    //   • Shift+drag → drag this single item without disturbing the current
    //     selection (same settle behavior as a plain drag).
    // We can't know which until pointerup, so begin a single-item drag now and
    // remember to toggle the selection on release if nothing moved.
    if (e.shiftKey) {
      this.dragPlane.constant = -placement.y;
      this.raycaster.setFromCamera(this.pointer, this.sm.camera);
      const hit0 = new THREE.Vector3();
      this.raycaster.ray.intersectPlane(this.dragPlane, hit0);
      // Auto-carry whatever is stacked on the item (same rigid-group mechanics
      // as a multi-select drag), so dragging a base moves its whole tower.
      const carryIds = this.carriedDependents(scenario.placements, [id]);
      const carryMembers = scenario.placements.filter((p) => carryIds.has(p.id));
      this.dragging = {
        members: carryMembers.map((p) => ({
          placement: p,
          offset: new THREE.Vector3(hit0.x - p.x, 0, hit0.z - p.z),
          lastValid: { x: p.x, y: p.y, z: p.z },
          start: { x: p.x, y: p.y, z: p.z },
        })),
        isGroup: carryMembers.length > 1,
        moveSet: carryIds,
        anchor: new THREE.Vector3(hit0.x, 0, hit0.z),
        moved: false,
        shiftToggleId: id, // toggle selection on pointerup if no drag occurs
      };
      return;
    }

    // Plain click. If the item is already part of a multi-selection, keep the
    // whole set and drag it as one group. Otherwise select just this item.
    if (!inMultiSelection) {
      this.cb.onSelect(id);
    }

    // Determine the group of placements to move. A multi-selection moves every
    // member together; a single item moves itself and auto-carries whatever is
    // stacked on top of it (same rigid-group mechanics).
    const moveIds = inMultiSelection
      ? this.getSelectedIds()
      : [...this.carriedDependents(scenario.placements, [id])];
    const members = moveIds
      .map((mid) => scenario.placements.find((p) => p.id === mid))
      .filter(Boolean);
    const isGroup = members.length > 1;

    // Begin drag on the horizontal plane at the primary item's base height.
    this.dragPlane.constant = -placement.y;
    this.raycaster.setFromCamera(this.pointer, this.sm.camera);
    const hit = new THREE.Vector3();
    this.raycaster.ray.intersectPlane(this.dragPlane, hit);
    // Anchor = pointer's XZ on the drag plane. Each member records its own
    // offset from the anchor so the group translates rigidly.
    this.dragging = {
      members: members.map((p) => ({
        placement: p,
        offset: new THREE.Vector3(hit.x - p.x, 0, hit.z - p.z),
        lastValid: { x: p.x, y: p.y, z: p.z },
        start: { x: p.x, y: p.y, z: p.z },
      })),
      isGroup,
      // Group drags translate rigidly (each member keeps its height) so the set
      // moves "as one"; single-item drags settle at the lowest legal rest.
      moveSet: new Set(moveIds),
      anchor: new THREE.Vector3(hit.x, 0, hit.z),
      moved: false,
    };
  }

  /** Current multi-selection ids (falls back to the single selected id). */
  getSelectedIds() {
    if (this.cb.getSelectedIds) {
      const ids = this.cb.getSelectedIds();
      if (Array.isArray(ids)) return ids;
    }
    const one = this.cb.getSelectedId();
    return one ? [one] : [];
  }

  onMove(e) {
    if (!this.dragging) return;
    this.setPointer(e);
    this.raycaster.setFromCamera(this.pointer, this.sm.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, hit)) return;

    if (this.dragging.isGroup) {
      this.moveGroup(hit);
    } else {
      this.moveSingle(hit);
    }
  }

  /** True when the caller has snap-to-grid enabled (defaults on if unset). */
  snapEnabled() {
    return !this.cb.getSnapEnabled || this.cb.getSnapEnabled() !== false;
  }

  /**
   * Single-item drag: settle at the lowest legal rest under the pointer — the
   * floor when it is free, otherwise on top of whatever legal supports are
   * beneath (stacking rules enforced) — so an item can be dragged across
   * stacked cargo instead of rubber-banding the moment the floor is covered.
   */
  moveSingle(hit) {
    const d = this.dragging.members[0];
    const p = d.placement;
    const spec = this.cb.getContainerSpec();
    const x = hit.x - d.offset.x;
    const z = hit.z - d.offset.z;

    // Distinguish a real drag attempt from a plain click: the pointer must
    // travel a little from the drag anchor before a blocked drop is worth
    // explaining on release.
    const anchor = this.dragging.anchor;
    if (anchor && Math.hypot(hit.x - anchor.x, hit.z - anchor.z) > 0.05) {
      this.dragging.attempted = true;
    }

    // Fit the item at the pointer spot. The current orientation is tried
    // first; if it doesn't fit there, fitAtSpot retries the item rotated 90°
    // and tipped (unless the catalog marks it do-not-tip), re-centered on the
    // pointer — so dragging into a gap that only fits rotated auto-reorients
    // the item instead of rejecting the move outright.
    const fit = fitAtSpot(x, z, activeScenario().placements, spec, p.dims, {
      item: catalogItem(p.catalogItemId) || p,
      baseLookup: (o) => catalogItem(o.catalogItemId) || o,
      skipId: p.id,
      stack: true,
      snapGrid: this.snapEnabled(),
      validate: (candidate) => this.candidateError([{ ...p, ...candidate }]),
      diag: (reason) => { this.dragging.lastReject = reason; },
    });

    if (fit) {
      this.dragging.lastReject = null;
      const reoriented =
        fit.dims.l !== p.dims.l || fit.dims.w !== p.dims.w || fit.dims.h !== p.dims.h;
      if (reoriented) {
        // Compose the orientation change with the item's current rot metadata,
        // matching the vocabulary rotate (R) / tip (T) already use.
        p.rot = {
          rot: ((p.rot?.rot || 0) + fit.rot.rot) % 360,
          tipped: fit.rot.tipped ? !p.rot?.tipped : !!p.rot?.tipped,
        };
        p.dims = fit.dims;
        toast(`${fit.rot.tipped ? 'Tipped' : 'Rotated'} "${p.name}" to fit`, 'ok');
      }
      p.x = fit.x;
      p.z = fit.z;
      p.y = fit.y;
      p.layer = p.y <= 1e-6 ? 0 : 1;
      d.lastValid = { x: p.x, y: p.y, z: p.z };
      this.dragging.moved = true;
    } else {
      // Keep the item at its last valid, non-overlapping pose.
      p.x = d.lastValid.x;
      p.y = d.lastValid.y;
      p.z = d.lastValid.z;
      p.layer = p.y <= 1e-6 ? 0 : 1;
    }
    this.sm.upsertPlacement(p, true);
  }

  /**
   * Group drag: translate every selected item rigidly by a single XZ delta,
   * preserving each member's relative position and height. The delta is clamped
   * so the group's bounding footprint stays inside the container, then the pose
   * is accepted only if no member collides with a non-selected item; otherwise
   * the whole group holds its last valid pose.
   */
  moveGroup(hit) {
    const spec = this.cb.getContainerSpec();
    const members = this.dragging.members;

    // Distinguish a real drag attempt from a plain click (same as moveSingle).
    const anchor = this.dragging.anchor;
    if (anchor && Math.hypot(hit.x - anchor.x, hit.z - anchor.z) > 0.05) {
      this.dragging.attempted = true;
    }

    // Desired delta from the drag anchor, then clamp so no member leaves the
    // container footprint. We clamp the shared delta (not each item) so the
    // group stays rigid.
    let dx = hit.x - this.dragging.anchor.x;
    let dz = hit.z - this.dragging.anchor.z;
    // Snap the shared delta so every member's resulting position lands on
    // the 1" grid (relative to the primary member's last valid pose) while
    // the whole group stays rigid.
    if (this.snapEnabled()) {
      const primary = members[0].start;
      dx = snapToGrid(primary.x + dx) - primary.x;
      dz = snapToGrid(primary.z + dz) - primary.z;
    }
    for (const m of members) {
      const p = m.placement;
      const base = m.start; // anchor-relative delta applies to the drag-start pose
      dx = Math.max(-base.x, Math.min(dx, spec.length - p.dims.l - base.x));
      dz = Math.max(-base.z, Math.min(dz, spec.width - p.dims.w - base.z));
    }

    // Build candidate poses for the whole group at the clamped delta.
    const moveSet = this.dragging.moveSet;
    const others = activeScenario().placements.filter((o) => !moveSet.has(o.id));
    const candidates = members.map((m) => ({
      ...m.placement,
      x: m.start.x + dx,
      z: m.start.z + dz,
      y: m.start.y,
      dims: m.placement.dims,
    }));

    // Accept only if every member clears the non-selected items and the move
    // introduces no new layout error; remember why not so onUp can explain.
    const noCollision = candidates.every((c) => !collidesAny(c, others));
    const error = noCollision ? this.candidateError(candidates) : 'overlaps other cargo';
    const accepted = !error;
    this.dragging.lastReject = error || null;

    for (let i = 0; i < members.length; i++) {
      const p = members[i].placement;
      if (accepted) {
        const c = candidates[i];
        p.x = c.x;
        p.z = c.z;
        p.y = c.y;
        p.layer = p.y <= 1e-6 ? 0 : 1;
        members[i].lastValid = { x: p.x, y: p.y, z: p.z };
      } else {
        const lv = members[i].lastValid;
        p.x = lv.x;
        p.y = lv.y;
        p.z = lv.z;
        p.layer = p.y <= 1e-6 ? 0 : 1;
      }
      this.sm.upsertPlacement(p, true);
    }
    if (accepted && (dx !== 0 || dz !== 0)) this.dragging.moved = true;
  }

  onUp() {
    if (this.dragging) {
      if (this.dragging.moved) {
        // A Shift+drag that actually stacked a single item selects it (matching
        // the classic behavior) so state and highlight stay in sync.
        if (this.dragging.shiftToggleId) {
          this.cb.onSelect(this.dragging.shiftToggleId);
        }
        this.cb.onChange();
      } else if (this.dragging.shiftToggleId && !this.dragging.attempted) {
        // Shift+click without a drag: toggle the item in the multi-selection.
        this.cb.onSelect(this.dragging.shiftToggleId, { toggle: true });
      } else if (this.dragging.attempted && this.dragging.lastReject) {
        // A real drag that never found a legal pose: explain why instead of
        // silently snapping back. When the dragged item is carrying a stack,
        // point at the way out (move the whole stack as a group).
        let msg = this.dragging.lastReject;
        if (/unsupported/.test(msg)) {
          msg += ' — move the whole stack together (Shift-click to multi-select)';
        }
        toast(msg, 'warn');
      }
    }
    this.dragging = null;
  }

  onDblClick(e) {
    if (this.cb.isMeasuring && this.cb.isMeasuring()) return; // Measure tool owns the canvas
    this.setPointer(e);
    const group = this.pickPlacement();
    if (group) this.cb.onDetails(group.userData.placementId);
  }

  onKey(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.target?.isContentEditable ||
        document.querySelector('.modal-backdrop')) return;
    if (this.cb.isMeasuring && this.cb.isMeasuring()) return; // Measure tool owns keyboard shortcuts
    const scenario = activeScenario();
    const id = this.cb.getSelectedId();
    const p = scenario?.placements.find((x) => x.id === id);
    const key = e.key.toLowerCase();

    // ---- Fine-tune move: nudge the selected item along the viewer's axes ----
    // Arrow keys move on the ground plane relative to the current camera view;
    // PageUp/PageDown move vertically. Default step is 1 inch; hold Alt for a
    // coarse 6 inch step. Directions are resolved against the live camera so
    // "left/right/up/down" always match what the user sees on screen.
    const NUDGE = { arrowleft: 'left', arrowright: 'right', arrowup: 'forward', arrowdown: 'back', pageup: 'up', pagedown: 'down' };
    if (NUDGE[key]) {
      if (!p || !this.editAllowed()) return;
      e.preventDefault();
      const step = (e.altKey ? 6 : 1) / 12; // feet (6" coarse, 1" fine)
      this.nudgeByView(NUDGE[key], step);
      return;
    }

    // View toggles stay available in view-only mode; the mutating shortcuts
    // (rotate/tip/edit/delete) are gated by editAllowed() below.
    if (key === 'l') {
      this.cb.onToggleLabels();
    } else if (key === 'p') {
      this.cb.onTogglePending();
    } else if (key === 'g') {
      this.cb.onToggleSnap();
    } else if (key === 'd') {
      this.cb.onToggleOpenings();
    } else if (!this.editAllowed()) {
      // Mutating shortcut (R/T/E/Delete) in view-only mode: ignore.
      return;
    } else if (key === 'r' && p) {
      this.transformPlacement(p, (d) => ({
        dims: { l: d.w, w: d.l, h: d.h },
        rot: { ...(p.rot || {}), rot: ((p.rot?.rot || 0) + 90) % 360 },
      }), 'rotate');
    } else if (key === 't' && p) {
      // Respect the catalog item's "do not tip" flag: never allow laying it
      // on its side, whether tipping in or reverting back to upright.
      const base = catalogItem(p.catalogItemId);
      if (base?.noTip && !p.rot?.tipped) {
        toast(`"${p.name}" is marked do-not-tip and cannot be laid on its side`, 'warn');
      } else {
        this.transformPlacement(p, (d) => ({
          dims: { l: d.h, w: d.w, h: d.l },
          rot: { ...(p.rot || {}), tipped: !p.rot?.tipped },
        }), 'tip');
      }
    } else if (key === 'e' && p) {
      this.cb.onEdit(id);
    } else if (key === 'delete' || key === 'backspace') {
      // Delete every selected item (whole multi-selection), not just primary.
      const ids = [...this.getSelectedIds()].sort((a, b) =>
        (scenario.placements.find((p) => p.id === b)?.y || 0) - (scenario.placements.find((p) => p.id === a)?.y || 0));
      if (!ids.length) return;
      e.preventDefault();
      for (const delId of ids) this.cb.onDelete(delId);
    }
  }

  clampInside(p) {
    const spec = this.cb.getContainerSpec();
    p.x = Math.max(0, Math.min(p.x, spec.length - p.dims.l));
    p.z = Math.max(0, Math.min(p.z, spec.width - p.dims.w));
    if (p.y + p.dims.h > spec.height) p.y = Math.max(0, spec.height - p.dims.h);
  }

  /**
   * Error INTRODUCED by substituting `candidates` into the current layout, or
   * null when the move is safe. Mirrors removalError's semantics: compares
   * layout validation before and after the move and only reports NEW problems
   * (e.g. cargo the move would strand), so pre-existing layout issues
   * elsewhere — a floating legacy item, an over-payload container — cannot
   * block an unrelated drag, nudge or transform. Shares removalError's
   * first-error-only limitation (a pre-existing error can mask a second new
   * one).
   */
  candidateError(candidates) {
    const spec = this.cb.getContainerSpec();
    const placements = activeScenario().placements;
    const replacements = new Map(candidates.map((p) => [p.id, p]));
    const before = layoutError(placements, spec, catalogItem);
    const after = layoutError(placements.map((p) => replacements.get(p.id) || p), spec, catalogItem);
    return after && after !== before ? after : null;
  }

  /**
   * Ids that must move along with `rootIds` because they rest on them:
   * placements supported directly or transitively by the carried set, EXCEPT
   * any item already fully supported by cargo outside the set (an item merely
   * touching the dragged base but resting entirely on something else stays
   * put). Mirrors the support predicate layoutError uses.
   */
  carriedDependents(placements, rootIds) {
    const carried = new Set(rootIds);
    const restsOn = (p, q) =>
      Math.abs(q.y + q.dims.h - p.y) < 1e-4 && overlapsXZ(p, q) && canStack(p, q);
    for (let grew = true; grew;) {
      grew = false;
      for (const p of placements) {
        if (carried.has(p.id) || p.y <= COLLISION_EPS) continue;
        const onCarried = placements.some((q) => carried.has(q.id) && restsOn(p, q));
        if (!onCarried) continue;
        const outsideSupports = placements.filter((q) => q !== p && !carried.has(q.id) && restsOn(p, q));
        if (isFullySupported(p, outsideSupports)) continue; // doesn't need the carried set
        carried.add(p.id);
        grew = true;
      }
    }
    return carried;
  }

  /**
   * Resolve the two horizontal container axes ("right" and "forward") as seen
   * from the live camera. Each is the dominant world axis (±X = length, ±Z =
   * width) of the camera's screen-right and ground-projected view direction,
   * so nudging with the arrow keys/pad always tracks what the user sees.
   * Returns unit deltas: { right:{x,z}, forward:{x,z} }.
   */
  viewerAxes() {
    const cam = this.sm.camera;
    // Camera-right = first column of the world matrix.
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    right.y = 0;
    // Forward = where the camera looks, flattened onto the ground plane.
    const forward = new THREE.Vector3();
    cam.getWorldDirection(forward);
    forward.y = 0;

    const snap = (v, fallback) => {
      if (v.lengthSq() < 1e-8) return fallback;
      // Snap to the dominant of the two horizontal axes.
      return Math.abs(v.x) >= Math.abs(v.z)
        ? { x: Math.sign(v.x) || 1, z: 0 }
        : { x: 0, z: Math.sign(v.z) || 1 };
    };
    return {
      right: snap(right, { x: 1, z: 0 }),
      forward: snap(forward, { x: 0, z: 1 }),
    };
  }

  /**
   * Nudge the selected item by `step` feet in a view-relative direction:
   * 'right' | 'left' | 'forward' | 'back' | 'up' | 'down'. Horizontal moves use
   * the camera-aligned axes; up/down use world height and float freely (bounded
   * only by the container and collisions).
   */
  nudgeByView(dir, step) {
    if (dir === 'up') return this.nudgeSelected({ dy: step });
    if (dir === 'down') return this.nudgeSelected({ dy: -step });
    const { right, forward } = this.viewerAxes();
    const sign = dir === 'left' || dir === 'back' ? -1 : 1;
    const axis = dir === 'right' || dir === 'left' ? right : forward;
    this.nudgeSelected({ dx: axis.x * step * sign, dz: axis.z * step * sign });
  }

  /**
   * Apply a world-space translation {dx,dy,dz} (feet) to the whole selection,
   * reusing the same validation as dragging: clamp inside the container, reject
   * (and revert) if the result overlaps a non-selected item. The set moves as
   * one rigid unit — the delta is clamped so every member stays in-bounds and
   * the move is all-or-nothing. Commits + notifies on success so stats/panels
   * refresh.
   */
  nudgeSelected({ dx = 0, dy = 0, dz = 0 } = {}) {
    if (!this.editAllowed()) return;
    const scenario = activeScenario();
    if (!scenario) return;
    const ids = this.getSelectedIds();
    const members = ids
      .map((id) => scenario.placements.find((x) => x.id === id))
      .filter(Boolean);
    if (!members.length) return;

    const spec = this.cb.getContainerSpec();
    // Clamp the shared delta so no member leaves the container on any axis,
    // keeping the group rigid.
    let cdx = dx;
    let cdy = dy;
    let cdz = dz;
    for (const p of members) {
      cdx = Math.max(-p.x, Math.min(cdx, spec.length - p.dims.l - p.x));
      cdz = Math.max(-p.z, Math.min(cdz, spec.width - p.dims.w - p.z));
      cdy = Math.max(-p.y, Math.min(cdy, spec.height - p.dims.h - p.y));
    }

    // No effective movement (e.g. already flush against a wall): do nothing.
    if (cdx === 0 && cdy === 0 && cdz === 0) return;

    const moveSet = new Set(ids);
    const others = scenario.placements.filter((o) => !moveSet.has(o.id));

    // Apply the delta to a candidate pose for each member, then validate the
    // whole group against non-selected items.
    const candidates = members.map((p) => ({
      ...p,
      x: p.x + cdx,
      y: p.y + cdy,
      z: p.z + cdz,
      dims: p.dims,
    }));
    const blocked = candidates.some((c) => collidesAny(c, others)) || this.candidateError(candidates);
    if (blocked) {
      // Nothing moved yet (we validated candidates), just warn and refresh.
      for (let i = 0; i < members.length; i++) this.sm.upsertPlacement(members[i], true);
      toast(typeof blocked === 'string' ? blocked : 'Blocked — no room to move there', 'warn');
      return;
    }

    for (let i = 0; i < members.length; i++) {
      const p = members[i];
      const c = candidates[i];
      p.x = c.x;
      p.y = c.y;
      p.z = c.z;
      p.layer = p.y <= 1e-6 ? 0 : 1;
      this.sm.upsertPlacement(p, true);
    }
    this.cb.onChange();
  }

  /**
   * Apply a reversible transform (rotate/tip) to a placement. The candidate
   * pose is validated BEFORE the placement is touched — committed only if the
   * result stays inside the container, overlaps nothing and introduces no new
   * layout error; otherwise the placement keeps its original pose.
   */
  transformPlacement(p, makeChange, label) {
    if (!this.editAllowed()) return;
    const candidate = {
      ...p,
      dims: { ...p.dims },
      rot: { ...(p.rot || {}) },
    };
    const change = makeChange(candidate.dims);
    candidate.dims = change.dims;
    candidate.rot = change.rot;
    this.clampInside(candidate);

    const error = this.candidateError([candidate]);
    if (collidesAny(candidate, activeScenario().placements) || error) {
      // Rejected: not enough room for this orientation here.
      this.sm.upsertPlacement(p, true);
      toast(error || `Not enough room to ${label} here`, 'warn');
      return;
    }
    p.dims = candidate.dims;
    p.rot = candidate.rot;
    p.x = candidate.x;
    p.y = candidate.y;
    p.z = candidate.z;
    this.sm.upsertPlacement(p, true);
    this.cb.onChange();
  }
}

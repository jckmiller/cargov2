// Showcase mode: a chrome-free, full-screen, slowly revolving turntable
// presentation of the active container and its cargo. It only READS the scene
// (camera + overlay visibility), never edits it, so it is available to every
// signed-in role — admin, editor and view-only Viewer alike (see main.js's
// toggleShowcase; nothing here needs permission gating).
//
// The turntable is OrbitControls' built-in autoRotate: SceneManager's render
// loop already calls controls.update() every frame, so the scene revolves with
// no extra loop code. Manual orbit/zoom stay live; dragging pauses the
// auto-rotation and it resumes a moment after release (pause-on-drag).
import * as THREE from 'three';
import { el, toast } from './ui.js';
import { getContainer } from './container.js';

// OrbitControls autoRotateSpeed: 2.0 == 30 s per orbit; 1.0 is a calm ~60 s.
const AUTO_ROTATE_SPEED = 1.0;
// Grace period after the user stops dragging before the turntable resumes,
// so the position damping settles first instead of fighting the resume.
const RESUME_DELAY_MS = 1500;

let current = null; // { sm, saved, host, cleanup, resumeTimer } while active

/** True while the showcase presentation is running. */
export function isShowcasing() {
  return !!current;
}

export function enterShowcase(sm, project, scenario) {
  if (current || !sm || !scenario) return;
  const app = document.getElementById('app');
  const host = document.getElementById('showcase-ui');
  if (!app || !host) return;

  // ---- Snapshot everything touched so exit restores the exact prior view ----
  const saved = {
    cameraPos: sm.camera.position.clone(),
    target: sm.controls.target.clone(),
    zoom: sm.camera.zoom,
    pendingVisible: sm.pendingGroup.visible,
    openingsVisible: sm.openingGroup.visible,
    measureVisible: sm.measureGroup.visible,
  };

  // ---- Frame the live camera on the whole container (fit-contain, iso angle) ----
  // Mirrors SceneManager.makeIsoCamera(): bounding sphere + vertical/horizontal
  // FOV fit with margin, then the same elevated three-quarter viewing
  // direction, so any container type (20' vs 40'HC) is fully in frame.
  const spec = getContainer(scenario.containerType);
  const { length: L, width: W, height: H } = spec;
  const target = new THREE.Vector3(L / 2, H / 2, W / 2);
  const radius = Math.sqrt(L * L + W * W + H * H) / 2;
  const vFov = THREE.MathUtils.degToRad(sm.camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * sm.canvasAspect());
  const distance = Math.max(radius / Math.sin(vFov / 2), radius / Math.sin(hFov / 2)) * 1.18;
  const dir = new THREE.Vector3(0.62, 0.55, 0.86).normalize();
  sm.camera.zoom = 1;
  sm.camera.position.copy(target).addScaledVector(dir, distance);
  sm.camera.lookAt(target);
  sm.camera.updateProjectionMatrix();
  sm.controls.target.copy(target);
  sm.controls.update();

  // ---- Turntable on; plain left-drag orbits (no Ctrl/Cmd gymnastics) ----
  sm.controls.autoRotate = true;
  sm.controls.autoRotateSpeed = AUTO_ROTATE_SPEED;
  sm.setShowcaseControls(true);

  // A clean presentation: only the container, its cargo and their labels.
  // (Boundary catcher planes are raycast-only and never visible anyway.)
  sm.setPendingVisible(false);
  sm.openingGroup.visible = false;
  sm.measureGroup.visible = false;

  // ---- Pause-on-drag: stop revolving while the user orbits, resume after ----
  const onPause = () => {
    if (!current) return;
    sm.controls.autoRotate = false;
    clearTimeout(current.resumeTimer);
  };
  const onResume = () => {
    if (!current) return;
    clearTimeout(current.resumeTimer);
    current.resumeTimer = setTimeout(() => {
      if (current) sm.controls.autoRotate = true;
    }, RESUME_DELAY_MS);
  };
  sm.controls.addEventListener('start', onPause);
  sm.controls.addEventListener('end', onResume);

  // Esc always leaves the showcase. Note: when fullscreen is active the
  // browser consumes the first Esc to leave fullscreen — a second Esc (or the
  // always-visible Exit button) then closes the showcase.
  const onKey = (e) => {
    if (e.key === 'Escape') exitShowcase();
  };
  // Keep the canvas sized through the fullscreen/layout transition.
  const onFsChange = () => setTimeout(() => sm.resize(), 60);
  window.addEventListener('keydown', onKey);
  document.addEventListener('fullscreenchange', onFsChange);

  // ---- HUD: project/container caption + stats + exit affordance ----
  const items = scenario.placements || [];
  const totalWeight = items.reduce((w, p) => w + (p?.weight || 0), 0);
  host.replaceChildren(
    el('div', { class: 'showcase-hud' }, [
      el('h2', { text: project?.name || 'Untitled Project' }),
      el('p', { class: 'muted', text: `${scenario.name || 'Container'} · ${spec.name}` }),
      el('div', { class: 'showcase-stats' }, [
        el('div', {}, [
          el('span', { class: 'muted small', text: 'Items' }),
          el('strong', { text: String(items.length) }),
        ]),
        el('div', {}, [
          el('span', { class: 'muted small', text: 'Total weight' }),
          el('strong', { text: `${Math.round(totalWeight).toLocaleString()} lb` }),
        ]),
      ]),
    ]),
    el('div', { class: 'showcase-controls' }, [
      el('span', { class: 'showcase-hint small', text: 'Drag to orbit · scroll to zoom · Esc to exit' }),
      el('button', { class: 'btn primary', text: 'Exit Showcase', onClick: () => exitShowcase() }),
    ])
  );
  host.classList.remove('hidden');

  app.classList.add('showcase-mode');
  syncShowcaseButton(true);

  // Fullscreen is best-effort: denied requests / unsupported browsers are fine.
  const wrap = document.querySelector('.scene-wrap');
  if (wrap?.requestFullscreen) {
    const req = wrap.requestFullscreen();
    if (req && req.catch) req.catch(() => {});
  }
  // Re-fit the canvas while the fixed-position layout and fullscreen settle.
  let ticks = 0;
  const resizeTimer = setInterval(() => {
    sm.resize();
    if (++ticks > 13) clearInterval(resizeTimer);
  }, 30);

  current = { sm, saved, host, resumeTimer: null };
  current.cleanup = () => {
    clearInterval(resizeTimer);
    clearTimeout(current.resumeTimer);
    sm.controls.removeEventListener('start', onPause);
    sm.controls.removeEventListener('end', onResume);
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', onFsChange);
  };

  toast('Showcase mode — press Esc to exit', 'ok');
}

export function exitShowcase() {
  if (!current) return;
  const { sm, saved, host, cleanup } = current;
  cleanup();

  // Stop the turntable and hand plain left-drag back to cargo dragging.
  sm.controls.autoRotate = false;
  sm.setShowcaseControls(false);

  // Restore the exact pre-showcase viewpoint and overlay states.
  sm.camera.zoom = saved.zoom;
  sm.camera.position.copy(saved.cameraPos);
  sm.controls.target.copy(saved.target);
  sm.camera.updateProjectionMatrix();
  sm.controls.update();
  sm.setPendingVisible(saved.pendingVisible);
  sm.openingGroup.visible = saved.openingsVisible;
  sm.measureGroup.visible = saved.measureVisible;

  host.classList.add('hidden');
  host.replaceChildren();
  document.getElementById('app')?.classList.remove('showcase-mode');
  syncShowcaseButton(false);

  if (document.fullscreenElement && document.exitFullscreen) {
    const req = document.exitFullscreen();
    if (req && req.catch) req.catch(() => {});
  }
  setTimeout(() => sm.resize(), 60);

  current = null;
}

/** Reflect showcase state on the scene-toolbar toggle button. */
function syncShowcaseButton(activeState) {
  const btn = document.getElementById('btn-showcase');
  if (!btn) return;
  btn.classList.toggle('active', activeState);
  btn.setAttribute('aria-pressed', String(activeState));
}

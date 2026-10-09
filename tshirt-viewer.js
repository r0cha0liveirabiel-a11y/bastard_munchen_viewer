/*!
 * TshirtViewer
 * Viewer 360° à partir d'images pré-rendues (Blender).
 * - Séquence horizontale (H) et séquence verticale (V), qui se rejoignent sur la vue de face.
 * - Vues haute définition pour le zoom, chargées à la demande.
 * - Souris, tactile (glisser, pincer, double-tap) et clavier.
 * Aucune dépendance.
 */
(() => {
  'use strict';

  const DEFAULTS = {
    trigger: '[data-tshirt-viewer]', // éléments qui ouvrent le viewer au clic
    frames: 72,                      // nombre d'images par séquence
    firstNumber: 1,                  // numéro de la première image (1 ou 0)
    pad: 8,                          // nombre de chiffres dans les noms (00000001 = 8)
    src: null,                       // (kind, axis, num) => url — kind : 'nav' | 'low' | 'zoom'
    lowRes: true,                    // aperçus basse définition chargés en premier
    sharedFront: true,               // la vue de face de H sert aussi pour V (pas de fichier V n°0)
    zoomFrames: { H: [], V: [] },    // numéros des images qui ont une version HD
    invertH: false,                  // inverse le sens du glisser horizontal
    invertV: false,                  // inverse le sens du glisser vertical
    pixelsPerFrame: 8,               // sensibilité : pixels de glisser pour avancer d'une image
    background: '#ffffff',           // doit correspondre exactement au fond du site
    maxZoom: 4,                      // zoom maximal si aucune image HD n'est disponible
    concurrency: 6,                  // téléchargements simultanés
    labels: {
      dialog: 'Vue 360° du t-shirt',
      canvas: 'T-shirt en 360°. Flèches pour tourner, + et − pour zoomer, Échap pour fermer.',
      close: 'Fermer',
      zoomIn: 'Zoomer',
      zoomOut: 'Dézoomer',
      reset: 'Revenir à la vue de face',
      hintMouse: 'Glissez pour faire tourner, molette pour zoomer',
      hintTouch: 'Glissez pour faire tourner, pincez pour zoomer',
      loading: 'Chargement'
    }
  };

  const ICONS = {
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    reset: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 3.5v4h4"/></svg>'
  };

  const mod = (n, m) => ((n % m) + m) % m;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const circDist = (a, b, m) => { const d = Math.abs(mod(a, m) - mod(b, m)); return Math.min(d, m - d); };
  const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const easeOut = t => 1 - Math.pow(1 - t, 3);

  // src peut être un chemin ou une liste de chemins possibles, essayés dans l'ordre
  async function loadImage(src) {
    const list = Array.isArray(src) ? src : [src];
    for (const s of list) {
      try { return await loadOne(s); } catch (e) { /* essai suivant */ }
    }
    throw new Error('Image introuvable : ' + list.join(' ou '));
  }

  function loadOne(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        const decoded = img.decode ? img.decode().catch(() => {}) : Promise.resolve();
        decoded.then(() => resolve(img));
      };
      img.onerror = () => reject(new Error('Image introuvable : ' + src));
      img.src = src;
    });
  }

  class TshirtViewer {
    constructor(options = {}) {
      this.o = { ...DEFAULTS, ...options, labels: { ...DEFAULTS.labels, ...(options.labels || {}) } };
      this.o.zoomFrames = { H: [], V: [], ...(options.zoomFrames || {}) };
      if (typeof this.o.src !== 'function') throw new Error('[TshirtViewer] option "src" manquante.');

      this.N = this.o.frames;
      this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.coarse = window.matchMedia('(pointer: coarse)').matches;

      // État de la vue
      this.axis = 'H';      // séquence affichée
      this.pos = 0;         // position (flottante) dans la séquence
      this.scale = 1;
      this.tx = 0;
      this.ty = 0;
      this.zoomKey = null;  // vue HD utilisée pendant le zoom
      this.busy = false;    // rotation automatique en cours
      this.isOpen = false;

      // Images
      this.cache = { nav: { H: [], V: [] }, low: { H: [], V: [] } };
      this.zoomCache = new Map();
      this.tasks = [];
      this.active = 0;
      this.started = false;
      this.initialKind = this.o.lowRes ? 'low' : 'nav';
      this.initialTotal = 0;
      this.initialDone = 0;

      // Interactions
      this.pointers = new Map();
      this.drag = null;
      this.pinch = null;
      this.lastTap = null;
      this.anim = 0;
      this.inertia = 0;
      this.zoomAnim = 0;
      this.raf = 0;

      this._onResize = () => this._resize();

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this._bindTriggers());
      } else {
        this._bindTriggers();
      }
    }

    /* ---------- Déclencheurs ---------- */

    _bindTriggers() {
      document.querySelectorAll(this.o.trigger).forEach(el => {
        el.addEventListener('click', e => { e.preventDefault(); this.open(el); });
        // Commence à charger dès le survol pour gagner du temps
        el.addEventListener('pointerenter', () => this._startLoading(), { once: true });
        const native = el.tagName === 'BUTTON' || el.tagName === 'A';
        if (!native) {
          if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
          if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
          el.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.open(el); }
          });
        }
      });
    }

    open(trigger) {
      if (!this.root) this._build();
      if (this.isOpen) return;
      this.isOpen = true;
      this.lastFocus = trigger || document.activeElement;
      this._startLoading();
      this._resetView();
      this.root.hidden = false;
      document.documentElement.classList.add('tsv-lock');
      this._resize();
      requestAnimationFrame(() => this.root.classList.add('is-open'));
      window.addEventListener('resize', this._onResize);
      this.canvas.focus({ preventScroll: true });
    }

    close() {
      if (!this.isOpen) return;
      this.isOpen = false;
      this._stopMotion();
      this.pointers.clear();
      this.drag = null;
      this.pinch = null;
      this.root.classList.remove('is-open');
      document.documentElement.classList.remove('tsv-lock');
      window.removeEventListener('resize', this._onResize);
      const hide = () => { if (!this.isOpen) this.root.hidden = true; };
      if (this.reduced) hide(); else setTimeout(hide, 260);
      if (this.lastFocus && this.lastFocus.focus) this.lastFocus.focus({ preventScroll: true });
    }

    /* ---------- Construction du DOM ---------- */

    _build() {
      const L = this.o.labels;
      const root = document.createElement('div');
      root.className = 'tsv';
      root.hidden = true;
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-label', L.dialog);
      root.style.setProperty('--tsv-bg', this.o.background);
      root.innerHTML = `
        <canvas class="tsv__canvas" tabindex="0" role="img" aria-label="${L.canvas}"></canvas>
        <div class="tsv__loader" aria-hidden="true">
          <span class="tsv__loader-bar"></span>
          <span class="tsv__loader-text"></span>
        </div>
        <button type="button" class="tsv__btn tsv__close" aria-label="${L.close}">${ICONS.close}</button>
        <p class="tsv__hint">${this.coarse ? L.hintTouch : L.hintMouse}</p>
        <div class="tsv__controls">
          <button type="button" class="tsv__btn" data-act="out" aria-label="${L.zoomOut}">${ICONS.minus}</button>
          <span class="tsv__zoom" aria-live="polite">100 %</span>
          <button type="button" class="tsv__btn" data-act="in" aria-label="${L.zoomIn}">${ICONS.plus}</button>
          <span class="tsv__sep" aria-hidden="true"></span>
          <button type="button" class="tsv__btn" data-act="reset" aria-label="${L.reset}">${ICONS.reset}</button>
        </div>`;
      document.body.appendChild(root);

      this.root = root;
      this.canvas = root.querySelector('.tsv__canvas');
      this.ctx = this.canvas.getContext('2d');
      this.loaderBar = root.querySelector('.tsv__loader-bar');
      this.loaderText = root.querySelector('.tsv__loader-text');
      this.zoomLabel = root.querySelector('.tsv__zoom');

      const c = this.canvas;
      c.addEventListener('pointerdown', e => this._onDown(e));
      c.addEventListener('pointermove', e => this._onMove(e));
      c.addEventListener('pointerup', e => this._onUp(e, false));
      c.addEventListener('pointercancel', e => this._onUp(e, true));
      c.addEventListener('wheel', e => this._onWheel(e), { passive: false });
      c.addEventListener('contextmenu', e => e.preventDefault());

      root.querySelector('.tsv__close').addEventListener('click', () => this.close());
      root.querySelector('.tsv__controls').addEventListener('click', e => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        this._dismissHint();
        if (b.dataset.act === 'in') this._zoomTo(null, null, this.scale <= 1.001 ? 2 : this.scale * 1.6, true);
        else if (b.dataset.act === 'out') this._zoomOutStep();
        else this._resetAll();
      });
      root.addEventListener('keydown', e => this._onKey(e));

      this._progress();
      this._updateZoomUI();
    }

    /* ---------- Chargement des images ---------- */

    _num(i) {
      return String(this.o.firstNumber + i).padStart(this.o.pad, '0');
    }

    _startLoading() {
      if (this.started) return;
      this.started = true;
      const kinds = this.o.lowRes ? ['low', 'nav'] : ['nav'];
      for (const kind of kinds) {
        for (const axis of ['H', 'V']) {
          for (let i = 0; i < this.N; i++) {
            if (this.o.sharedFront && axis === 'V' && i === 0) continue;
            this.tasks.push({ kind, axis, i });
          }
        }
      }
      this.initialTotal = 2 * this.N - (this.o.sharedFront ? 1 : 0);
      this._pump();
    }

    // Plus le score est bas, plus l'image est prioritaire
    _priority(t) {
      const same = t.axis === this.axis;
      let p = circDist(t.i, same ? this._frame() : 0, this.N);
      if (!same) p += this.N;                             // l'autre séquence ensuite
      if (t.kind === 'nav' && this.o.lowRes) p += 2 * this.N; // la HD après les aperçus
      return p;
    }

    _pump() {
      while (this.active < this.o.concurrency && this.tasks.length) {
        let best = 0;
        let bestP = Infinity;
        for (let k = 0; k < this.tasks.length; k++) {
          const p = this._priority(this.tasks[k]);
          if (p < bestP) { bestP = p; best = k; }
        }
        const t = this.tasks.splice(best, 1)[0];
        this.active++;
        loadImage(this.o.src(t.kind, t.axis, this._num(t.i)))
          .then(img => {
            this.cache[t.kind][t.axis][t.i] = img;
            if (!this.aspect) { this.aspect = img.naturalWidth / img.naturalHeight; this._clampPan(); }
          })
          .catch(err => console.warn('[TshirtViewer] ' + err.message))
          .finally(() => {
            this.active--;
            if (t.kind === this.initialKind) { this.initialDone++; this._progress(); }
            this._requestRender();
            this._pump();
          });
      }
    }

    _progress() {
      if (!this.root) return;
      const pct = this.initialTotal ? Math.round((100 * this.initialDone) / this.initialTotal) : 0;
      this.loaderBar.style.transform = `scaleX(${pct / 100})`;
      this.loaderText.textContent = `${this.o.labels.loading} ${pct} %`;
      this.root.classList.toggle('is-loaded', this.initialTotal > 0 && pct >= 100);
    }

    _zoomId(k) { return k.axis + k.idx; }

    _loadZoom(k) {
      const id = this._zoomId(k);
      if (this.zoomCache.has(id)) return;
      const entry = { img: null, failed: false };
      this.zoomCache.set(id, entry);
      loadImage(this.o.src('zoom', k.axis, this._num(k.idx)))
        .then(img => {
          entry.img = img;
          if (this.zoomKey && this._zoomId(this.zoomKey) === id) {
            const max = this._maxZoom();
            if (this.scale > max) { const [cx, cy] = this._center(); this._applyZoom(cx, cy, max); }
          }
          this._requestRender();
        })
        .catch(err => { entry.failed = true; console.warn('[TshirtViewer] ' + err.message); })
        .finally(() => this._updateZoomUI());
    }

    /* ---------- Rendu ---------- */

    _frame() { return mod(Math.round(this.pos), this.N); }

    _pickImage() {
      if (this.scale > 1.001 && this.zoomKey) {
        const z = this.zoomCache.get(this._zoomId(this.zoomKey));
        if (z && z.img) return z.img;
      }
      const f = this._frame();
      const get = (axis, i) => this.cache.nav[axis][i] || this.cache.low[axis][i];
      // La vue de face est identique dans les deux séquences
      let img = get(this.axis, f) || (f === 0 ? get(this.axis === 'H' ? 'V' : 'H', 0) : null);
      if (img) return img;
      // En attendant le chargement : l'image disponible la plus proche
      for (let d = 1; d <= this.N / 2; d++) {
        img = get(this.axis, mod(f + d, this.N)) || get(this.axis, mod(f - d, this.N));
        if (img) return img;
      }
      return null;
    }

    _resize() {
      if (!this.canvas) return;
      const r = this.canvas.getBoundingClientRect();
      this.rect = r;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.cw = r.width;
      this.ch = r.height;
      this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
      this._clampPan();
      this._render();
    }

    // Taille de l'image à zoom 1, en laissant de la place à l'interface
    _fit() {
      const ar = this.aspect || 1;
      const mx = Math.max(this.cw * 0.04, 16);
      const my = Math.max(this.ch * 0.06, 96);
      const aw = Math.max(1, this.cw - 2 * mx);
      const ah = Math.max(1, this.ch - 2 * my);
      let w = aw;
      let h = w / ar;
      if (h > ah) { h = ah; w = h * ar; }
      return { w, h };
    }

    _requestRender() {
      if (this.raf || !this.ctx || !this.isOpen) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this._render(); });
    }

    _render() {
      const { ctx } = this;
      if (!ctx || !this.cw) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = this.o.background;
      ctx.fillRect(0, 0, this.cw, this.ch);

      const img = this._pickImage();
      if (!img) return;

      const { w, h } = this._fit();
      const dw = w * this.scale;
      const dh = h * this.scale;
      const x = this.cw / 2 + this.tx - dw / 2;
      const y = this.ch / 2 + this.ty - dh / 2;

      // Ne dessiner que la partie visible (important pour les images 6K)
      const vx0 = Math.max(0, x);
      const vy0 = Math.max(0, y);
      const vx1 = Math.min(this.cw, x + dw);
      const vy1 = Math.min(this.ch, y + dh);
      if (vx1 <= vx0 || vy1 <= vy0) return;
      const kx = img.naturalWidth / dw;
      const ky = img.naturalHeight / dh;

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        img,
        (vx0 - x) * kx, (vy0 - y) * ky, (vx1 - vx0) * kx, (vy1 - vy0) * ky,
        vx0, vy0, vx1 - vx0, vy1 - vy0
      );
    }

    /* ---------- Rotation ---------- */

    // Rotation automatique vers une image, par le chemin le plus court
    _animateTo(idx) {
      const cur = this.pos;
      let delta = mod(idx - cur, this.N);
      if (delta > this.N / 2) delta -= this.N;
      const to = cur + delta;
      if (this.reduced || Math.abs(delta) < 0.5) {
        this.pos = mod(Math.round(to), this.N);
        this._requestRender();
        return Promise.resolve();
      }
      this.busy = true;
      const duration = Math.min(700, 160 + Math.abs(delta) * 14);
      const t0 = performance.now();
      return new Promise(resolve => {
        const step = now => {
          const k = Math.min(1, (now - t0) / duration);
          this.pos = cur + delta * easeInOut(k);
          this._requestRender();
          if (k < 1) {
            this.anim = requestAnimationFrame(step);
          } else {
            this.pos = mod(Math.round(to), this.N);
            this.busy = false;
            this.anim = 0;
            resolve();
          }
        };
        this.anim = requestAnimationFrame(step);
      });
    }

    // Les deux séquences ne se croisent qu'en vue de face : on y revient avant de changer d'axe
    async _switchAxis(axis) {
      if (this._frame() !== 0) await this._animateTo(0);
      this.axis = axis;
      this.pos = 0;
      if (this.drag) this.drag.samples = [];
      this._requestRender();
    }

    _startInertia(v) {
      let last = performance.now();
      const step = now => {
        const dt = Math.min(48, now - last);
        last = now;
        this.pos += v * dt;
        v *= Math.pow(0.94, dt / 16);
        this._requestRender();
        if (Math.abs(v) > 0.002) {
          this.inertia = requestAnimationFrame(step);
        } else {
          this.inertia = 0;
          this.pos = mod(Math.round(this.pos), this.N);
        }
      };
      this.inertia = requestAnimationFrame(step);
    }

    _stopInertia() {
      if (this.inertia) cancelAnimationFrame(this.inertia);
      this.inertia = 0;
    }

    _stopMotion() {
      this._stopInertia();
      if (this.anim) cancelAnimationFrame(this.anim);
      if (this.zoomAnim) cancelAnimationFrame(this.zoomAnim);
      this.anim = 0;
      this.zoomAnim = 0;
      this.busy = false;
    }

    _sign(axis) {
      return axis === 'H' ? (this.o.invertH ? -1 : 1) : (this.o.invertV ? -1 : 1);
    }

    async _keyRotate(axis, dir) {
      if (this.busy) return;
      this._stopInertia();
      if (this.scale > 1.001) { await this._leaveZoom(); return; }
      if (axis !== this.axis) await this._switchAxis(axis);
      this.pos = mod(Math.round(this.pos) + dir * this._sign(axis), this.N);
      this._requestRender();
    }

    _resetView() {
      this._stopMotion();
      this.axis = 'H';
      this.pos = 0;
      this._resetZoom();
    }

    async _resetAll() {
      this._stopInertia();
      if (this.scale > 1.001) { const [cx, cy] = this._center(); await this._animateScale(cx, cy, 1); }
      if (this.busy) return;
      await this._animateTo(0);
      this.axis = 'H';
      this.pos = 0;
      this._requestRender();
    }

    /* ---------- Zoom ---------- */

    _center() {
      const r = this.rect || { left: 0, top: 0 };
      return [r.left + this.cw / 2, r.top + this.ch / 2];
    }

    _maxZoom() {
      const z = this.zoomKey && this.zoomCache.get(this._zoomId(this.zoomKey));
      if (!z || !z.img) return this.o.maxZoom;
      // Jusqu'à 1,5 × la résolution réelle de l'image HD
      const { w } = this._fit();
      return Math.max(2, (z.img.naturalWidth / (w * this.dpr)) * 1.5);
    }

    // Vue HD la plus proche de l'angle affiché
    _nearestKey() {
      const f = this._frame();
      const first = this.o.firstNumber;
      const other = this.axis === 'H' ? 'V' : 'H';
      const cands = (this.o.zoomFrames[this.axis] || []).map(n => ({ axis: this.axis, idx: n - first }));
      // La vue de face HD sert aux deux séquences
      if ((this.o.zoomFrames[other] || []).includes(first)) cands.push({ axis: other, idx: 0 });
      let best = null;
      for (const c of cands) {
        if (c.idx < 0 || c.idx >= this.N) continue;
        const dist = circDist(c.idx, f, this.N);
        if (!best || dist < best.dist) best = { ...c, dist };
      }
      return best;
    }

    _clampPan() {
      if (!this.cw) return;
      const { w, h } = this._fit();
      const mx = Math.max(0, w * this.scale - this.cw, w * this.scale - w) / 2;
      const my = Math.max(0, h * this.scale - this.ch, h * this.scale - h) / 2;
      this.tx = clamp(this.tx, -mx, mx);
      this.ty = clamp(this.ty, -my, my);
    }

    // Zoom ancré sur un point de l'écran (coordonnées client)
    _applyZoom(cx, cy, s) {
      s = clamp(s, 1, this._maxZoom());
      if (s <= 1.001) { this._resetZoom(); return; }
      const r = this.rect || { left: 0, top: 0 };
      const px = cx - r.left - this.cw / 2;
      const py = cy - r.top - this.ch / 2;
      const k = s / this.scale;
      this.tx = px - (px - this.tx) * k;
      this.ty = py - (py - this.ty) * k;
      this.scale = s;
      this._clampPan();
      this._updateZoomUI();
      this._requestRender();
    }

    _resetZoom() {
      this.scale = 1;
      this.tx = 0;
      this.ty = 0;
      this.zoomKey = null;
      this._updateZoomUI();
      this._requestRender();
    }

    _animateScale(cx, cy, to, duration = 280) {
      if (this.zoomAnim) cancelAnimationFrame(this.zoomAnim);
      if (this.reduced) { this._applyZoom(cx, cy, to); return Promise.resolve(); }
      const from = this.scale;
      const t0 = performance.now();
      return new Promise(resolve => {
        const step = now => {
          const k = Math.min(1, (now - t0) / duration);
          this._applyZoom(cx, cy, from + (to - from) * easeOut(k));
          if (k < 1) { this.zoomAnim = requestAnimationFrame(step); }
          else { this.zoomAnim = 0; resolve(); }
        };
        this.zoomAnim = requestAnimationFrame(step);
      });
    }

    // Avant de zoomer : rotation vers la vue HD la plus proche, puis chargement de cette vue
    async _enterZoom(cx, cy, s, animate) {
      if (this.busy) return;
      this._stopInertia();
      const key = this._nearestKey();
      if (key) {
        if (key.dist > 0) await this._animateTo(key.idx);
        this.zoomKey = key;
        this._loadZoom(key);
      }
      if (animate) await this._animateScale(cx, cy, s);
      else this._applyZoom(cx, cy, s);
    }

    _zoomTo(cx, cy, s, animate) {
      if (cx == null) [cx, cy] = this._center();
      if (this.scale <= 1.001) return this._enterZoom(cx, cy, s, animate);
      return animate ? this._animateScale(cx, cy, s) : this._applyZoom(cx, cy, s);
    }

    _zoomBy(cx, cy, f) {
      if (this.busy) return;
      if (this.scale <= 1.001) {
        if (f > 1) this._enterZoom(cx, cy, f, false);
        return;
      }
      this._applyZoom(cx, cy, this.scale * f);
    }

    _zoomOutStep() {
      if (this.scale <= 1.001) return;
      const s = this.scale / 1.6;
      const [cx, cy] = this._center();
      this._animateScale(cx, cy, s < 1.15 ? 1 : s);
    }

    // Retour automatique à 100 %, utilisé quand on glisse pendant un zoom
    async _leaveZoom() {
      if (this.leaving || this.scale <= 1.001) return;
      this.leaving = true;
      this.busy = true;
      const [cx, cy] = this._center();
      await this._animateScale(cx, cy, 1, 220);
      this.leaving = false;
      this.busy = false;
      // La rotation reprend avec la suite du geste
      if (this.drag) { this.drag.axis = null; this.drag.samples = []; }
    }

    _updateZoomUI() {
      if (!this.root) return;
      const zoomed = this.scale > 1.001;
      this.zoomLabel.textContent = Math.round(this.scale * 100) + ' %';
      this.root.classList.toggle('is-zoomed', zoomed);
      const z = this.zoomKey && this.zoomCache.get(this._zoomId(this.zoomKey));
      this.root.classList.toggle('is-zoom-loading', !!(zoomed && z && !z.img && !z.failed));
    }

    /* ---------- Pointeurs (souris, tactile, stylet) ---------- */

    _newDrag(x, y, moved) {
      return { x0: x, y0: y, lx: x, ly: y, axis: null, moved, samples: [] };
    }

    _pinchState() {
      const [a, b] = [...this.pointers.values()];
      return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }

    _dismissHint() {
      if (this.hintGone || !this.root) return;
      this.hintGone = true;
      this.root.classList.add('is-touched');
    }

    _onDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      this.canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this._stopInertia();
      this._dismissHint();
      if (this.pointers.size === 1) {
        this.drag = this._newDrag(e.clientX, e.clientY, false);
      } else if (this.pointers.size === 2) {
        this.drag = null;
        this.pinch = this._pinchState();
      }
    }

    _onMove(e) {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;

      // Pincer pour zoomer
      if (this.pinch) {
        if (this.pointers.size < 2) return;
        const st = this._pinchState();
        const f = st.dist / this.pinch.dist;
        if (this.busy) { this.pinch = st; return; }
        if (this.scale <= 1.001) {
          if (f > 1.03) { this._enterZoom(st.mx, st.my, f, false); this.pinch = st; }
          return;
        }
        this._applyZoom(st.mx, st.my, this.scale * f);
        this.pinch = st;
        return;
      }

      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.lx;
      const dy = e.clientY - d.ly;
      d.lx = e.clientX;
      d.ly = e.clientY;
      if (Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) > 5) d.moved = true;

      // Zoomé : un glisser ramène à 100 %, puis la rotation suit le geste
      if (this.scale > 1.001) { if (d.moved) this._leaveZoom(); return; }
      if (this.busy) return;

      // L'axe est choisi au début du geste selon la direction dominante
      if (!d.axis) {
        const ox = e.clientX - d.x0;
        const oy = e.clientY - d.y0;
        if (Math.hypot(ox, oy) < 6) return;
        d.axis = Math.abs(ox) >= Math.abs(oy) ? 'H' : 'V';
        if (d.axis !== this.axis) { this._switchAxis(d.axis); return; }
      }
      if (d.axis !== this.axis) return;

      const delta = ((d.axis === 'H' ? dx : dy) * this._sign(d.axis)) / this.o.pixelsPerFrame;
      this.pos += delta;
      const now = performance.now();
      d.samples.push({ t: now, p: this.pos });
      while (d.samples.length > 2 && now - d.samples[0].t > 100) d.samples.shift();
      this._requestRender();
    }

    _onUp(e, cancelled) {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);

      if (this.pinch) {
        if (this.pointers.size < 2) {
          this.pinch = null;
          if (this.scale > 1.001 && this.scale < 1.08) { const [cx, cy] = this._center(); this._animateScale(cx, cy, 1); }
          const rest = this.pointers.values().next().value;
          this.drag = rest ? this._newDrag(rest.x, rest.y, true) : null;
        }
        return;
      }

      const d = this.drag;
      this.drag = null;
      if (!d || cancelled) return;
      if (!d.moved) { this._tap(e); return; }
      if (this.scale > 1.001 || this.busy || d.axis !== this.axis) return;

      // Inertie au relâchement
      const s = d.samples;
      const now = performance.now();
      if (this.reduced || s.length < 2 || now - s[s.length - 1].t > 80) {
        this.pos = mod(Math.round(this.pos), this.N);
        return;
      }
      const v = clamp((s[s.length - 1].p - s[0].p) / Math.max(16, s[s.length - 1].t - s[0].t), -0.12, 0.12);
      if (Math.abs(v) > 0.004) this._startInertia(v);
      else this.pos = mod(Math.round(this.pos), this.N);
    }

    // Double-clic ou double-tap : zoom sur le point touché, ou retour à 100 %
    _tap(e) {
      const now = performance.now();
      const t = this.lastTap;
      if (t && now - t.t < 320 && Math.hypot(e.clientX - t.x, e.clientY - t.y) < 30) {
        this.lastTap = null;
        if (this.scale > 1.001) { const [cx, cy] = this._center(); this._animateScale(cx, cy, 1); }
        else this._zoomTo(e.clientX, e.clientY, 2.5, true);
      } else {
        this.lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
    }

    _onWheel(e) {
      e.preventDefault();
      this._dismissHint();
      // ctrlKey = pincement sur pavé tactile (macOS)
      const k = e.deltaMode === 1 ? 0.05 : e.ctrlKey ? 0.01 : 0.0015;
      this._zoomBy(e.clientX, e.clientY, Math.exp(-e.deltaY * k));
    }

    /* ---------- Clavier ---------- */

    _onKey(e) {
      const k = e.key;
      if (k === 'Escape') { e.preventDefault(); this.close(); return; }
      if (k === 'Tab') { this._trapFocus(e); return; }
      const zoomed = this.scale > 1.001;
      let handled = true;
      switch (k) {
        case 'ArrowLeft': this._keyRotate('H', -1); break;
        case 'ArrowRight': this._keyRotate('H', 1); break;
        case 'ArrowUp': this._keyRotate('V', -1); break;
        case 'ArrowDown': this._keyRotate('V', 1); break;
        case '+': case '=': this._zoomTo(null, null, zoomed ? this.scale * 1.4 : 2, true); break;
        case '-': case '_': this._zoomOutStep(); break;
        case '0': this._resetAll(); break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); this._dismissHint(); }
    }

    _trapFocus(e) {
      const items = [...this.root.querySelectorAll('canvas, button')];
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  window.TshirtViewer = {
    init: options => new TshirtViewer(options)
  };
})();

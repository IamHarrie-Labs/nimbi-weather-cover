/* Nimbi motion engine — cursor follow, character reveals, nav collapse, and
   the consensus wheel. Vanilla, no animation library: a pinned scroll stage
   with a handful of orbiting cards is simple enough to drive with one scroll
   listener and requestAnimationFrame, and that keeps the whole site to one
   runtime dependency (ethers, only on the buy page). */

// ---------------------------------------------------------------- cursor
export function initCursor(root = document) {
  const el = document.createElement("div");
  el.className = "cursor-follow";
  document.body.appendChild(el);

  let raf = null;
  let tx = 0, ty = 0;
  const move = (x, y) => {
    tx = x; ty = y;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      el.style.transform = `translate(${tx}px, ${ty}px)`;
      raf = null;
    });
  };
  window.addEventListener("mousemove", (e) => move(e.clientX, e.clientY));

  root.querySelectorAll("[data-cursor]").forEach((zone) => {
    zone.addEventListener("mouseenter", () => {
      el.textContent = zone.dataset.cursor;
      el.classList.add("active");
      document.body.classList.add("cursor-hidden");
    });
    zone.addEventListener("mouseleave", () => {
      el.classList.remove("active");
      document.body.classList.remove("cursor-hidden");
    });
  });
}

// ---------------------------------------------------------------- reveals
/** Split text into per-character spans inside a clipping mask, then reveal
 *  on intersection. Splitting per word (not per letter) for longer lines
 *  keeps the DOM light and still reads as a reveal. */
export function prepareReveal(el, { by = "word" } = {}) {
  const text = el.textContent;
  const parts = by === "char" ? [...text] : text.split(/(\s+)/);
  el.textContent = "";
  el.classList.add("reveal-line");
  parts.forEach((part, i) => {
    if (part === "" ) return;
    const span = document.createElement("span");
    span.className = by === "char" ? "ch" : "word";
    span.textContent = part === " " ? " " : part;
    span.style.transitionDelay = `${i * (by === "char" ? 18 : 40)}ms`;
    el.appendChild(span);
  });
}

export function observeReveals(selector = "[data-reveal]") {
  const els = document.querySelectorAll(selector);
  els.forEach((el) => prepareReveal(el, { by: el.dataset.reveal || "word" }));
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.4 },
  );
  els.forEach((el) => io.observe(el));
}

export function observeClips(selector = ".card-clip") {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.2 },
  );
  document.querySelectorAll(selector).forEach((el) => io.observe(el));
}

// ---------------------------------------------------------------- nav
export function initNavCollapse(navEl, thresholdPx = 80) {
  const apply = () => navEl.classList.toggle("collapsed", window.scrollY > thresholdPx);
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { apply(); ticking = false; });
  });
  // A reload while scrolled down (browsers restore scroll position on
  // refresh) should show the right nav state immediately, not wait for the
  // next scroll event.
  apply();
}

// ---------------------------------------------------------------- marquee
export function initMarquee(trackEl, speedPxPerSec = 60) {
  // Duplicate content once so the loop can wrap seamlessly.
  trackEl.innerHTML = trackEl.innerHTML + trackEl.innerHTML;
  let x = 0;
  let last = performance.now();
  function step(now) {
    const dt = (now - last) / 1000;
    last = now;
    x -= speedPxPerSec * dt;
    const half = trackEl.scrollWidth / 2;
    if (-x >= half) x += half;
    trackEl.style.transform = `translateX(${x}px)`;
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------- wheel
/**
 * The consensus wheel: six oracle readings arranged on a ring, driven
 * through three stages (read / consensus / settle) by scroll position
 * within a tall pinned wrapper.
 *
 * Cards orbit the ring's centre; each card's own element counter-rotates so
 * its text stays upright while the ring itself turns — the classic trick for
 * "things on a wheel that don't spin with the wheel."
 *
 * `outlierSlug` must always end up alone on the outer ring in stage 2 — that
 * is the one detail the whole visual exists to protect.
 */
export class ConsensusWheel {
  constructor(container, { onStage } = {}) {
    this.container = container;
    this.onStage = onStage || (() => {});
    this.cards = [];
    this.stage = 0; // 0 read, 1 consensus, 2 settle
    this.angle = 0;
    this._raf = null;
    this._spinning = true;
  }

  setReadings(readings, outlierSlugs) {
    this.container.innerHTML = "";
    this.cards = readings.map((r, i) => {
      const el = document.createElement("div");
      el.className = "wheel-card" + (outlierSlugs.has(r.slug) ? " is-outlier" : "");
      el.innerHTML = `<span class="wc-name">${r.slug}</span><span class="wc-val mono">${r.celsius.toFixed(1)}</span>`;
      this.container.appendChild(el);
      return { el, outlier: outlierSlugs.has(r.slug), baseAngle: (i / readings.length) * Math.PI * 2 };
    });
    this._layout();
    this._startSpin();
  }

  setStage(stage) {
    if (stage === this.stage) return;
    this.stage = stage;
    this.onStage(stage);
    if (stage === 0) this._startSpin();
    else this._stopSpin();
    this._layout();
  }

  _startSpin() {
    if (this._raf) return;
    const tick = () => {
      this.angle += 0.0016;
      this._layout();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  _stopSpin() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _layout() {
    const rect = this.container.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const outerR = Math.min(rect.width, rect.height) * 0.42;
    const innerR = outerR * 0.55;

    this.cards.forEach((c) => {
      const a = c.baseAngle + this.angle;
      // Stage 1+: agreeing cards pull to the inner ring; the outlier stays out.
      const onInner = this.stage >= 1 && !c.outlier;
      const r = this.stage === 0 ? outerR : (onInner ? innerR : outerR);
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      // Counter-rotate the card by -angle so its text stays upright while it
      // still orbits with the ring during stage 0.
      const counter = this.stage === 0 ? -this.angle : 0;
      // Centre the card on its ring point using its own rendered size, not a
      // guessed constant — the mini wheel on the buy page uses smaller cards
      // than the landing page's, and a fixed offset only centres one of them.
      const halfW = c.el.offsetWidth / 2 || 40;
      const halfH = c.el.offsetHeight / 2 || 24;
      c.el.style.transform = `translate(${x - halfW}px, ${y - halfH}px) rotate(${counter}rad)`;
      c.el.classList.toggle("in-ring", onInner);
      c.el.classList.toggle("out-ring", this.stage >= 1 && c.outlier);
    });
  }
}

/** Drive a ConsensusWheel's stage from scroll position inside a tall wrapper.
 *  `wrapper` should be significantly taller than the viewport (e.g. 300vh)
 *  so each stage gets real scroll distance rather than snapping instantly. */
export function pinnedStages(wrapper, stageCount, onChange) {
  let ticking = false;
  function update() {
    ticking = false;
    const rect = wrapper.getBoundingClientRect();
    const total = rect.height - window.innerHeight;
    if (total <= 0) return;
    const progressed = Math.min(1, Math.max(0, -rect.top / total));
    const stage = Math.min(stageCount - 1, Math.floor(progressed * stageCount));
    onChange(stage, progressed);
  }
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  });
  update();
}

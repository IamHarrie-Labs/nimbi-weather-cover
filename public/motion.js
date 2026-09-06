/* Nimbi motion engine: cursor follow, character reveals, nav collapse and
   mobile menu, the marquee, the oracle card row, and a small touch-friendly
   carousel. Vanilla, no animation library, so the whole site stays down to
   one runtime dependency (ethers, only on the buy page). */

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
/** Split text into per-word spans inside a clipping mask, then reveal on
 *  intersection. Word-level (not letter-level) keeps the DOM light and still
 *  reads as a reveal.
 *
 * Whitespace between words is kept as a plain text node, never wrapped in
 * its own span. A span whose *entire* content is one space is exactly the
 * "leading/trailing whitespace of an element" case the CSS spec says
 * browsers must strip, so an earlier version of this that wrapped every
 * token (including the spaces) silently ate every space in every heading:
 * "Weather cover" rendered as "Weathercover". A bare text node between two
 * elements doesn't hit that rule, so it survives, and screen readers,
 * copy/paste, and search all still see normal spaced-out text. */
export function prepareReveal(el, { by = "word" } = {}) {
  const text = el.textContent;

  if (by === "char") {
    el.textContent = "";
    el.classList.add("reveal-line");
    [...text].forEach((ch, i) => {
      const span = document.createElement("span");
      span.className = "ch";
      span.textContent = ch;
      span.style.transitionDelay = `${i * 18}ms`;
      el.appendChild(span);
    });
    return;
  }

  const tokens = text.split(/(\s+)/); // capturing group keeps whitespace as its own token
  el.textContent = "";
  el.classList.add("reveal-line");
  let wordIndex = 0;
  tokens.forEach((token) => {
    if (token === "") return;
    if (/^\s+$/.test(token)) {
      el.appendChild(document.createTextNode(token));
      return;
    }
    const span = document.createElement("span");
    span.className = "word";
    span.textContent = token;
    span.style.transitionDelay = `${wordIndex * 40}ms`;
    wordIndex++;
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

/** A real mobile menu: a button that opens a full dark panel with every nav
 *  link and the buy button, rather than just hiding links with nowhere to
 *  go. Closes on link click, outside click, or Escape. */
export function initMobileMenu(toggleEl, panelEl) {
  const open = () => { panelEl.classList.add("open"); toggleEl.setAttribute("aria-expanded", "true"); };
  const close = () => { panelEl.classList.remove("open"); toggleEl.setAttribute("aria-expanded", "false"); };
  toggleEl.addEventListener("click", () => (panelEl.classList.contains("open") ? close() : open()));
  panelEl.querySelectorAll("a").forEach((a) => a.addEventListener("click", close));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
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

// ---------------------------------------------------------------- oracle row
/**
 * Renders one oracle's reading as a card. Used both in the landing page's
 * Read/Consensus/Settle carousel and the buy page's mini settle view, so the
 * same visual vocabulary shows up everywhere this story is told.
 *
 * No motion of its own beyond a fade-in and a colour change: the earlier
 * version spun these cards around a ring, which looked lively but did most
 * of its work on a scroll-jacked pinned section that fought small screens
 * and ate a lot of code to keep six cards from overlapping. A plain row that
 * highlights the majority and dims the outlier says the same thing faster
 * and works the same way on a phone as it does on a desktop.
 */
export function renderOracleCards(container, readings, outlierSlugs, { stage = "read" } = {}) {
  container.innerHTML = "";
  readings.forEach((r) => {
    const isOutlier = outlierSlugs.has(r.slug);
    const el = document.createElement("div");
    el.className = "oracle-card";
    if (stage !== "read" && isOutlier) el.classList.add("is-outlier");
    if (stage !== "read" && !isOutlier) el.classList.add("is-agreeing");
    el.innerHTML = `<span class="oc-name">${r.slug}</span><span class="oc-val mono">${r.celsius.toFixed(1)}°</span>${
      stage !== "read" && isOutlier ? '<span class="oc-tag">excluded</span>' : ""
    }`;
    container.appendChild(el);
  });
}

// ---------------------------------------------------------------- drag-scroll
/** Wheel-to-horizontal-scroll plus pointer-drag for a horizontally
 *  scrollable stack. A vertical wheel gesture over the element scrolls it
 *  sideways (most trackpads/mice only send vertical deltas), and a mouse
 *  drag pans it the same way a touch swipe already does natively. */
export function initDragScroll(el) {
  el.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  let down = false, startX = 0, startScroll = 0;
  el.addEventListener("pointerdown", (e) => {
    down = true; startX = e.clientX; startScroll = el.scrollLeft;
    el.classList.add("grabbing");
  });
  window.addEventListener("pointerup", () => { down = false; el.classList.remove("grabbing"); });
  window.addEventListener("pointermove", (e) => { if (down) el.scrollLeft = startScroll - (e.clientX - startX); });
}


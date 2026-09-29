'use strict';
// Shared horizontal timeline: camera, input, and windowed SVG drawing for the
// home chart, the notes chart, and the expanded project chart.
//
// The caller prepares the data (which conversations, which lane, which label)
// and hands it over with setData(). From then on the chart owns movement:
// zoom, pan, pinch, momentum, resize, and the animation frame that draws them.
// A gesture never re-filters conversations, re-packs lanes, replaces the
// scroller, or reads coordinates from a previous drawing.
//
// Coordinates: x = gutter + (time - start) / DAY * scale, in chart pixels.
// Marks sit below a HEADER_HEIGHT strip that holds the date labels and the
// "now" caption. The caller owns the scroller's contents; destroy() releases
// listeners and observers but leaves the surface for the caller to replace.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TimelineChart = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DAY = 86400000;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HEADER_HEIGHT = 32;
  const DEFAULT_GUTTER = 8;
  const DEFAULT_RIGHT_PAD = 60;   // room past the end of history for the "now" caption
  const MAX_EXTENT = 8000000;     // px; browsers refuse larger scroll dimensions
  const MIN_MARK_WIDTH = 6;
  const LABEL_CHAR_PX = 7;        // conservative glyph width for the label budget
  const LABEL_GAP = 12;
  const MIN_TICK_SPACING = 75;    // px between grid lines before the step coarsens
  const BREAK_PX = 48;            // px a collapsed stretch of quiet time takes
  const TICK_STEPS_DAYS = [1 / 24, 3 / 24, 6 / 24, 1, 7, 30, 90, 365];
  const WINDOW_PAD = 256;         // px drawn beyond the viewport on each side
  const LABEL_REACH = 320;        // px a title may extend past its mark into the window
  const LANE_REACH = 32;          // px a mark may extend above or below its center
  const TAP_SLOP = 4;             // px of movement before a touch is a drag, not a tap
  const WHEEL_LINE_PX = 16;
  const WHEEL_ZOOM_RATE = 0.002;  // ln(factor) per wheel pixel
  const WHEEL_ZOOM_MS = 80;       // wheel notches are interpolated, not stepped
  const STEP_ZOOM_MS = 140;       // buttons and keys
  const MOMENTUM_DECAY_MS = 200;
  const MOMENTUM_REST = 0.03;     // px/ms
  const FLICK_WINDOW_MS = 80;     // a release this soon after the last move coasts
  const CLICK_SUPPRESS_MS = 400;
  const SETTLE_MS = 200;
  const CONTROL_SELECTOR = 'button, input, select, textarea, a';
  const GLYPHS = {
    triangle: (x, y) => `M${x - 4.5},${y}L${x + 4.5},${y}L${x},${y - 8}Z`,
    square: (x, y) => `M${x - 3},${y - 3}h6v6h-6Z`,
  };
  const noop = () => {};

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const prefersReducedMotion = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setAttributes(el, attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      const text = String(value);
      if (el.getAttribute(key) !== text) el.setAttribute(key, text);
    }
  }
  function svg(name, attrs = {}) {
    const el = document.createElementNS(SVG_NS, name);
    setAttributes(el, attrs);
    return el;
  }
  function lowerBound(items, value, key) {
    let lo = 0, hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (key(items[mid]) < value) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  let tickFormats = null;
  function formats() {
    return tickFormats ||= {
      time: new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }),
      day: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }),
      month: new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }),
    };
  }

  // Lane packing in time, not pixels: zoom changes distances, never the
  // vertical layout. Sets item.lane and returns the lane count.
  function packLanes(items, start = item => item.start, end = item => item.end) {
    const ends = [];
    const ordered = [...items].sort((a, b) => start(a) - start(b) || end(a) - end(b));
    for (const item of ordered) {
      let lane = ends.findIndex(value => value < start(item));
      if (lane < 0) lane = ends.length;
      ends[lane] = Math.max(start(item), end(item));
      item.lane = lane;
    }
    return ends.length;
  }

  // Grid lines on local calendar boundaries. Days advance as dates, not as
  // 24-hour durations, so daylight-saving changes keep midnight at midnight.
  // Major ticks are calendar days (or coarser); hours within a day are minor.
  function calendarTicks(first, last, pixelsPerDay) {
    const step = TICK_STEPS_DAYS.find(days => days * pixelsPerDay >= MIN_TICK_SPACING) || 365;
    const date = new Date(first);
    date.setMinutes(0, 0, 0);
    if (step < 1) date.setHours(Math.floor(date.getHours() / (step * 24)) * step * 24);
    else {
      date.setHours(0);
      if (step === 7) date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
      if (step >= 30) date.setDate(1);
      if (step === 90) date.setMonth(Math.floor(date.getMonth() / 3) * 3);
      if (step === 365) date.setMonth(0);
    }
    const out = [];
    while (+date <= last) {
      const midnight = date.getHours() === 0;
      const format = step < 1 && !midnight ? formats().time : step >= 30 ? formats().month : formats().day;
      out.push({ time: +date, label: format.format(date), major: step >= 1 || midnight });
      if (step < 1) date.setTime(+date + step * DAY);
      else if (step === 365) date.setFullYear(date.getFullYear() + 1);
      else if (step >= 30) date.setMonth(date.getMonth() + (step === 90 ? 3 : 1));
      else date.setDate(date.getDate() + step);
    }
    return out;
  }

  // Marks indexed by vertical track and start time, once per data change.
  // Prefix maxima of the end times let a window query skip everything that
  // ended before it while still finding long marks that cross it.
  function indexMarks(marks) {
    const byTrack = new Map();
    const ids = new Set();
    for (const mark of marks) {
      if (ids.has(mark.id)) throw new Error('Duplicate timeline mark: ' + mark.id);
      if (![mark.start, mark.end, mark.y].every(Number.isFinite) || mark.end < mark.start)
        throw new Error('Invalid timeline mark: ' + mark.id);
      ids.add(mark.id);
      if (!byTrack.has(mark.y)) byTrack.set(mark.y, []);
      byTrack.get(mark.y).push(mark);
      const bins = mark.bins?.length ? mark.bins : [1];
      const peak = Math.max(1, ...bins);
      const base = mark.fat ? 2.5 : 1.5, amplitude = mark.fat ? 9 : 6;
      mark.points = bins.map((v, i) => [(i + 0.5) / bins.length, base + amplitude * Math.sqrt(Math.max(0, v) / peak)]);
    }
    return [...byTrack].sort((a, b) => a[0] - b[0]).map(([y, entries]) => {
      entries.sort((a, b) => a.start - b.start || a.end - b.end);
      let end = -Infinity;
      return { y, entries, ends: entries.map(item => (end = Math.max(end, item.end))) };
    });
  }
  function marksInWindow(tracks, first, last, top, bottom) {
    const out = [];
    for (let i = lowerBound(tracks, top, t => t.y); i < tracks.length && tracks[i].y <= bottom; i++) {
      const { entries, ends } = tracks[i];
      for (let j = lowerBound(ends, first, n => n); j < entries.length && entries[j].start <= last; j++) out.push(entries[j]);
    }
    return out;
  }

  // ---- the time axis, with quiet time collapsed ----
  //
  // A stretch with no activity at least minGapMs long (between two marks, or
  // between the last mark and the end) is a gap. At a given scale a gap takes
  // min(its linear width, BREAK_PX) pixels: it is drawn to scale while that is
  // narrow and becomes a fixed break once it would be wider. The width is
  // continuous in the scale, so zooming never makes the layout jump; the time
  // inside a break is squeezed linearly into it.
  function findGaps(intervals, end, minGapMs) {
    if (!(minGapMs > 0) || !intervals.length) return [];
    const sorted = [...intervals].sort((a, b) => a.start - b.start);
    const gaps = [];
    let reach = sorted[0].end;
    for (const item of sorted) {
      if (item.start - reach >= minGapMs) gaps.push({ start: reach, end: item.start });
      reach = Math.max(reach, item.end);
    }
    if (end - reach >= minGapMs) gaps.push({ start: reach, end });
    return gaps;
  }
  // The time `activeMs` of activity before `end`: walking back, quiet gaps
  // do not count. "The last three days" of someone who was away all summer
  // are the three days before they left, not three empty ones.
  function activeSince(gaps, end, activeMs) {
    let t = end, left = activeMs;
    for (let i = gaps.length - 1; i >= 0 && left > 0; i--) {
      const gap = gaps[i];
      if (gap.start >= t) continue;
      const span = t - Math.min(t, gap.end);
      if (span >= left) return t - left;
      left -= span;
      t = Math.min(t, gap.start);
    }
    return t - left;
  }
  const gapWidth = (gap, scale) => Math.min((gap.end - gap.start) / DAY * scale, BREAK_PX);
  const collapsed = (gap, scale) => (gap.end - gap.start) / DAY * scale > BREAK_PX;
  // Pixels between two times at a scale, gaps accounted for. Pure: the fit
  // search evaluates it at many scales without touching the chart.
  function spanPixels(gaps, scale, from, to) {
    let px = (to - from) / DAY * scale;
    for (const gap of gaps) {
      const overlap = Math.min(gap.end, to) - Math.max(gap.start, from);
      if (overlap <= 0 || !collapsed(gap, scale)) continue;
      px += gapWidth(gap, scale) * overlap / (gap.end - gap.start) - overlap / DAY * scale;
    }
    return px;
  }
  // The scale at which [from, to] takes `pixels`. spanPixels grows with the
  // scale, so a bisection in log space finds it; without gaps it is exact.
  function scaleForSpan(gaps, from, to, pixels) {
    const span = Math.max(1, to - from);
    const linear = Math.max(1e-6, pixels / span * DAY);
    if (!gaps.some(gap => gap.end > from && gap.start < to)) return linear;
    let lo = Math.log(linear), hi = Math.log(1e7);
    if (spanPixels(gaps, Math.exp(hi), from, to) <= pixels) return Math.exp(hi);
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (spanPixels(gaps, Math.exp(mid), from, to) < pixels) lo = mid; else hi = mid;
    }
    return Math.exp(lo);
  }
  // x = origin + pixels from `start`; before `start` the axis extends linearly.
  class Axis {
    constructor(start, origin, gaps) {
      this.start = start; this.origin = origin; this.gaps = gaps;
      this.scale = 1; this.gapX = []; this.widths = [];
    }
    setScale(scale) {
      this.scale = scale;
      let x = this.origin, t = this.start;
      this.gapX = []; this.widths = [];
      for (const gap of this.gaps) {
        x += (gap.start - t) / DAY * scale;
        this.gapX.push(x);
        const w = gapWidth(gap, scale);
        this.widths.push(w);
        x += w;
        t = gap.end;
      }
    }
    x(time) {
      const i = lowerBound(this.gaps, time, gap => gap.end); // first gap not ended before time
      // Gaps before i ended at or before `time`.
      if (i < this.gaps.length && time > this.gaps[i].start) {
        const gap = this.gaps[i];
        return this.gapX[i] + (time - gap.start) / (gap.end - gap.start) * this.widths[i];
      }
      if (i === 0) return this.origin + (time - this.start) / DAY * this.scale;
      const prev = this.gaps[i - 1];
      return this.gapX[i - 1] + this.widths[i - 1] + (time - prev.end) / DAY * this.scale;
    }
    t(x) {
      const i = lowerBound(this.gapX, x, gx => gx); // first gap starting at or after x
      const k = i - 1;                             // the last gap starting before x
      if (k < 0) return this.start + (x - this.origin) / this.scale * DAY;
      const gap = this.gaps[k];
      if (x < this.gapX[k] + this.widths[k]) return gap.start + (x - this.gapX[k]) / this.widths[k] * (gap.end - gap.start);
      return gap.end + (x - this.gapX[k] - this.widths[k]) / this.scale * DAY;
    }
    // The drawn breaks overlapping [from, to]: gaps too wide to show to scale.
    breaksIn(from, to) {
      const out = [];
      this.gaps.forEach((gap, i) => {
        if (gap.end > from && gap.start < to && collapsed(gap, this.scale)) out.push({ ...gap, x: this.gapX[i], width: this.widths[i] });
      });
      return out;
    }
  }
  // "3 days", "5 weeks", "4 months": the quiet time a break stands for.
  function quietLabel(ms) {
    const days = ms / DAY;
    if (days < 14) return Math.round(days) + ' days';
    if (days < 60) return Math.round(days / 7) + ' weeks';
    if (days < 730) return Math.round(days / 30.44) + ' months';
    return Math.round(days / 365.25) + ' years';
  }

  class TimelineChart {
    static HEADER_HEIGHT = HEADER_HEIGHT;
    static packLanes = packLanes;
    static ticks = calendarTicks;
    static findGaps = findGaps;
    static activeSince = activeSince;
    static Axis = Axis;
    static scaleForSpan = scaleForSpan;
    static quietLabel = quietLabel;
    static BREAK_PX = BREAK_PX;

    #scroller; #options; #surface; #labels; #drawing; #defs;
    #bandLayer; #breakLayer; #tickLayer; #markLayer; #nowLine; #nowText;
    #abort = new AbortController(); #resize;
    #nodes = new Map(); #tickNodes = new Map(); #bandNodes = new Map(); #breakNodes = new Map();
    #model = null; #axis = null; #lead = 0; #tracks = []; #marksById = new Map(); #labelsHtml = ''; #defsHtml = '';
    // Camera. left/top are the unrounded scroll offsets the chart wants;
    // committedLeft/Top are what the browser last held, so native scrolling
    // between frames can be folded in as a delta.
    #scale; #left = 0; #top = 0; #width = 0; #height = 0; #chartWidth = 0; #chartHeight = 0;
    #committedLeft = 0; #committedTop = 0; #initial = true;
    #frame = 0; #settleTimer = 0; #destroyed = false;
    #animation = null; #momentum = null; #pending = null; #deferredData = null;
    // Touch gesture.
    #pointers = new Map(); #gesture = null; #dragged = false; #pinched = false;
    #velocity = { x: 0, y: 0 }; #sampleTime = 0; #suppressClickUntil = 0;

    // scale: pixels per day. fitMinimum: the whole history is the lowest zoom.
    // onDraw(frame) runs after every paint with the marks that were drawn;
    // onChange(state) after every camera change; onSettle(state) once the
    // camera has been still for a moment; onInteract() when the person acts.
    constructor({ scroller, scale = 160, minScale = 12.8, maxScale = 1280, fitMinimum = false,
      onDraw = noop, onChange = noop, onSettle = noop, onInteract = noop }) {
      this.#scroller = scroller;
      this.#scale = scale;
      this.#options = { minScale, maxScale, fitMinimum, onDraw, onChange, onSettle, onInteract };
      this.#mount();
      this.#listen();
    }

    #mount() {
      this.#surface = document.createElement('div');
      this.#surface.className = 'timeline';
      this.#labels = document.createElement('div');
      this.#labels.className = 'timeline-label-layer';
      this.#drawing = svg('svg', { 'aria-label': 'Conversation timeline' });
      this.#drawing.style.cssText = 'position:absolute;overflow:hidden;display:block;pointer-events:none';
      this.#defs = svg('defs');
      this.#bandLayer = svg('g');
      this.#breakLayer = svg('g');
      this.#tickLayer = svg('g');
      this.#markLayer = svg('g');
      const nowLayer = svg('g', { class: 'tnow' });
      this.#nowLine = svg('line');
      this.#nowText = svg('text', { y: HEADER_HEIGHT - 6 });
      this.#nowText.textContent = 'now';
      nowLayer.append(this.#nowLine, this.#nowText);
      this.#drawing.append(this.#defs, this.#bandLayer, this.#breakLayer, this.#tickLayer, nowLayer, this.#markLayer);
      this.#surface.append(this.#labels, this.#drawing);
      this.#scroller.replaceChildren(this.#surface);
      this.#scroller.classList.add('timeline-scroller');
    }

    #listen() {
      const on = (target, event, handler, options = {}) =>
        target.addEventListener(event, handler, { ...options, signal: this.#abort.signal });
      const scroller = this.#scroller;
      on(scroller, 'scroll', () => this.#onScroll(), { passive: true });
      on(scroller, 'wheel', e => this.#onWheel(e), { passive: false });
      on(scroller, 'pointerdown', e => this.#onPointerDown(e));
      on(scroller, 'pointermove', e => this.#onPointerMove(e));
      on(scroller, 'pointerup', e => this.#onPointerEnd(e));
      on(scroller, 'pointercancel', e => this.#onPointerEnd(e));
      // Taking capture from a touched mark makes the mark report a loss; that
      // is not the end of the gesture. Only the scroller's own loss is.
      on(scroller, 'lostpointercapture', e => {
        if (e.target === scroller && !scroller.hasPointerCapture(e.pointerId)) this.#onPointerEnd(e);
      });
      // A click that ends a drag is not a tap on whatever lies under the finger.
      // Keyboard activation (detail 0) is never suppressed.
      on(window, 'click', e => {
        if (e.detail && performance.now() < this.#suppressClickUntil && scroller.contains(e.target)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }, { capture: true });
      on(window, 'blur', () => this.stop());
      on(document, 'visibilitychange', () => { if (document.hidden) this.stop(); });
      if (window.screen?.orientation) on(window.screen.orientation, 'change', () => this.stop());
      this.#resize = new ResizeObserver(() => this.#schedule());
      this.#resize.observe(scroller);
    }

    // ---- public API ----

    get surface() { return this.#surface; }

    get state() {
      return {
        scale: this.#scale, left: this.#left, top: this.#top, width: this.#width, height: this.#height,
        center: this.#model ? this.#tFor(this.#left + this.#width / 2) : null,
      };
    }

    // data: { start, end, height, marks, gutter?, rightPad?, bands?, labelsHtml?, defs?,
    //         collapseGapsMs? (quiet stretches at least this long may become breaks) }
    // mark: { id, start, end, y, className?, attributes?, title?, label?, bins?,
    //         fat?, color?, live?, working?, active?, laneHeight?, minWidth?,
    //         labelMinScale?, labelCharWidth?, glyph? ('triangle' | 'square') }
    // band: { key, y, height, className? }
    // options: { fit?: true | spanMs, center?: time, top?: px,
    //            focus?: { from: time, ifEmpty?: boolean } }
    // The chart keeps the time under the viewport center (or stays pinned to
    // the end of history) unless an option places it. focus fits [from, end]
    // into the viewport; with ifEmpty, only when the current scale, pinned to
    // the end, would show no mark at all (a view of nothing but quiet time). Marks are owned by the
    // chart after this call: it annotates them with drawn geometry.
    setData(data, options = {}) {
      if (this.#destroyed) return;
      // Incoming activity must not move lanes under a finger. Keep only the
      // newest update and apply it when the gesture ends.
      if (this.#pointers.size) { this.#deferredData = [data, options]; return; }
      const model = { gutter: DEFAULT_GUTTER, rightPad: DEFAULT_RIGHT_PAD, height: 0, marks: [], bands: [], labelsHtml: '', defs: '', ...data };
      if (![model.start, model.end, model.height, model.gutter, model.rightPad].every(Number.isFinite) ||
          model.end < model.start || model.height < 0 || model.gutter < 0 || model.rightPad < 0)
        throw new Error('Invalid timeline extent');
      const tracks = indexMarks(model.marks);
      this.#readScroll();
      const keep = this.#model ? this.#anchor() : null;
      this.#model = model;
      this.#axis = new Axis(model.start, model.gutter, findGaps(model.marks, model.end, model.collapseGapsMs));
      this.#tracks = tracks;
      this.#marksById = new Map(model.marks.map(mark => [mark.id, mark]));
      if (this.#labelsHtml !== model.labelsHtml) {
        this.#labelsHtml = model.labelsHtml;
        this.#labels.innerHTML = model.labelsHtml; // escaped markup from the caller
      }
      this.#labels.style.height = model.height + 'px';
      this.#labels.style.width = model.gutter + 'px';
      if (this.#defsHtml !== model.defs) {
        this.#defsHtml = model.defs;
        this.#defs.innerHTML = model.defs;
      }
      keep?.();
      const { fit, center, top, focus } = options;
      if (fit || Number.isFinite(center) || Number.isFinite(top) || Number.isFinite(focus?.from)) {
        this.#pending = () => {
          if (Number.isFinite(focus?.from) && !(focus.ifEmpty && this.#showsMarks())) this.#fitFrom(focus.from);
          if (fit) this.#fitSpan(fit === true ? undefined : fit);
          if (Number.isFinite(center)) this.#left = this.#xFor(center) - this.#width / 2;
          if (Number.isFinite(top)) this.#top = top;
        };
      }
      this.#schedule();
    }

    // Multiply the scale, keeping the time under clientX (default: the
    // viewport center) where it is. animate: a short transition that a new
    // call retargets rather than restarts; touch input never animates.
    zoomBy(factor, { clientX, animate = false, duration = STEP_ZOOM_MS } = {}) {
      if (!this.#model || !Number.isFinite(factor) || factor <= 0) return;
      const target = (this.#animation?.to ?? this.#scale) * factor;
      this.#interrupt();
      const x = this.#anchorX(clientX);
      const time = this.#tFor(this.#left + x);
      const to = clamp(target, ...this.#limits());
      if (animate && !prefersReducedMotion()) {
        this.#animation = { from: this.#scale, to, time, x, duration, started: performance.now() };
      } else this.#applyScale(to, time, x);
      this.#schedule();
      this.#settle();
    }
    zoomTo(scale, options = {}) {
      this.zoomBy(scale / (this.#animation?.to ?? this.#scale), options);
    }
    // Fit spanMs (default: the whole history) into the viewport width.
    fit(spanMs) { this.#place(() => this.#fitSpan(spanMs)); }
    // Fit [time, end of history] into the viewport width, pinned to the end.
    fitFrom(time) { if (Number.isFinite(time)) this.#place(() => this.#fitFrom(time)); }
    // Put time at the given fraction of the viewport width.
    jump(time, fraction = 0.5) {
      if (!Number.isFinite(time)) return;
      this.#place(() => { this.#left = this.#xFor(time) - this.#width * fraction; });
    }
    jumpStart() { this.#place(() => { this.#left = 0; }); }

    // Release any gesture and transition, e.g. when the chart leaves the screen.
    stop() {
      if (this.#dragged && this.#pointers.size) this.#suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;
      for (const id of this.#pointers.keys()) if (this.#scroller.hasPointerCapture(id)) this.#scroller.releasePointerCapture(id);
      this.#pointers.clear();
      this.#gesture = null;
      this.#animation = this.#momentum = null;
      this.#flushDeferredData();
    }

    destroy() {
      if (this.#destroyed) return;
      this.#destroyed = true;
      this.stop();
      this.#abort.abort();
      this.#resize.disconnect();
      cancelAnimationFrame(this.#frame);
      clearTimeout(this.#settleTimer);
      this.#nodes.clear(); this.#tickNodes.clear(); this.#bandNodes.clear(); this.#breakNodes.clear(); this.#marksById.clear();
      this.#scroller.classList.remove('timeline-scroller');
    }

    // ---- camera ----

    // #lead: when all of history is narrower than the viewport, the axis is
    // shifted right so "now" sits at the right edge, with the days before the
    // first conversation on the left, rather than a screen of empty future.
    #xFor(time) { return this.#lead + this.#axis.x(time); }
    #tFor(x) { return this.#axis.t(x - this.#lead); }
    // The scale at which [from, end of history] fills the viewport.
    #scaleFrom(from) {
      const pixels = Math.max(1, this.#width - this.#model.gutter - this.#model.rightPad);
      return Math.max(1e-6, scaleForSpan(this.#axis.gaps, Math.min(from, this.#model.end - 1), this.#model.end, pixels));
    }
    #spanScale(spanMs) { return this.#scaleFrom(this.#model.end - Math.max(1, spanMs)); }
    #limits() {
      const { minScale, maxScale, fitMinimum } = this.#options;
      const history = Math.max(1, this.#model.end - this.#model.start);
      const low = fitMinimum ? this.#scaleFrom(this.#model.start) : minScale;
      const physical = (MAX_EXTENT - this.#model.gutter - this.#model.rightPad) / history * DAY;
      const high = Math.min(Math.max(low, maxScale), physical);
      return [Math.min(low, high), high];
    }
    // Clamp the scale and size the chart for it.
    #measure() {
      this.#scale = clamp(this.#scale, ...this.#limits());
      this.#axis.setScale(this.#scale);
      const content = this.#axis.x(this.#model.end) + this.#model.rightPad;
      this.#lead = Math.max(0, this.#width - content);
      this.#chartWidth = Math.max(this.#width, content + this.#lead);
      this.#chartHeight = Math.max(this.#height, this.#model.height);
    }
    #clampScroll() {
      this.#left = clamp(this.#left, 0, Math.max(0, this.#chartWidth - this.#width));
      this.#top = clamp(this.#top, 0, Math.max(0, this.#chartHeight - this.#height));
    }
    // What the viewer is looking at, as a function that puts it back after
    // the scale, the viewport, or the data changed: the end of history while
    // the view is pinned there (and before the first draw), else the center time.
    #anchor() {
      const atEnd = this.#initial || this.#chartWidth - this.#left - this.#width < 2;
      const center = this.#tFor(this.#left + this.#width / 2);
      return () => {
        this.#measure();
        this.#left = atEnd ? this.#chartWidth - this.#width : this.#xFor(center) - this.#width / 2;
        this.#clampScroll();
      };
    }
    #applyScale(scale, anchorTime, anchorX) {
      this.#scale = scale;
      this.#measure();
      this.#left = this.#xFor(anchorTime) - anchorX;
      this.#clampScroll();
    }
    #fitSpan(spanMs = this.#model.end - this.#model.start) {
      const keep = this.#anchor();
      this.#scale = this.#spanScale(spanMs);
      keep();
    }
    #fitFrom(from) {
      this.#scale = this.#scaleFrom(from);
      this.#measure();
      this.#left = this.#chartWidth - this.#width; // pinned to the end
      this.#clampScroll();
    }
    // Would the viewport, pinned to the end at the current scale, show any
    // mark? (A mark that ends inside the visible stretch of time.)
    #showsMarks() {
      this.#measure();
      const from = this.#tFor(Math.max(0, this.#chartWidth - this.#width) + this.#model.gutter);
      return this.#model.marks.some(mark => mark.end >= from);
    }
    // Viewport x of a client coordinate, no further left than the gutter.
    #anchorX(clientX) {
      if (clientX == null) return (this.#model.gutter + this.#width) / 2;
      const rect = this.#scroller.getBoundingClientRect();
      return clamp(clientX - rect.left - this.#scroller.clientLeft, Math.min(this.#model.gutter, this.#width), this.#width);
    }
    // Native scrollbar or keyboard movement since the last frame becomes a
    // delta on the camera, so it cannot overwrite a zoom queued for this frame.
    #readScroll() {
      this.#left += this.#scroller.scrollLeft - this.#committedLeft;
      this.#top += this.#scroller.scrollTop - this.#committedTop;
      this.#committedLeft = this.#scroller.scrollLeft;
      this.#committedTop = this.#scroller.scrollTop;
    }
    // The person acted: transitions and coasting stop, the caller can close
    // anything anchored to the old view.
    #interrupt() {
      this.#animation = this.#momentum = null;
      this.#readScroll();
      this.#options.onInteract();
    }
    #place(placement) {
      if (!this.#model) return;
      this.#interrupt();
      this.#pending = placement;
      this.#schedule();
      this.#settle();
    }
    #schedule() {
      if (!this.#destroyed && !this.#frame) this.#frame = requestAnimationFrame(now => this.#draw(now));
    }
    #settle() {
      clearTimeout(this.#settleTimer);
      this.#settleTimer = setTimeout(() => { if (!this.#destroyed && this.#model) this.#options.onSettle(this.state); }, SETTLE_MS);
    }
    #flushDeferredData() {
      const deferred = this.#deferredData;
      this.#deferredData = null;
      if (deferred) this.setData(...deferred);
    }

    // ---- frame ----

    #draw(now) {
      this.#frame = 0;
      if (this.#destroyed || !this.#model || !this.#scroller.isConnected) return;
      const width = this.#scroller.clientWidth, height = this.#scroller.clientHeight;
      if (!width || !height) { this.#animation = this.#momentum = null; return; } // hidden; the ResizeObserver reschedules
      this.#readScroll();
      this.#fitViewport(width, height);
      if (this.#pending) {
        const placement = this.#pending;
        this.#pending = null;
        placement();
        this.#clampScroll();
      }
      this.#stepAnimation(now);
      this.#stepMomentum(now);
      this.#commit();
      const marks = this.#paint();
      this.#options.onDraw({ ...this.state, marks, start: this.#model.start, end: this.#model.end });
      this.#options.onChange(this.state);
      if (this.#animation || this.#momentum) { this.#schedule(); this.#settle(); }
    }
    #fitViewport(width, height) {
      const resized = this.#width !== width || this.#height !== height;
      const keep = this.#anchor();
      const scaleBefore = this.#scale;
      this.#width = width;
      this.#height = height;
      this.#measure();
      if (this.#initial || resized || scaleBefore !== this.#scale) keep();
      else this.#clampScroll();
      if (resized && !this.#initial) this.#animation = null; // its anchor was in the old viewport
      this.#initial = false;
    }
    #stepAnimation(now) {
      const a = this.#animation;
      if (!a) return;
      const progress = clamp((now - a.started) / a.duration, 0, 1);
      const eased = 1 - (1 - progress) ** 3;
      this.#applyScale(a.from * (a.to / a.from) ** eased, a.time, a.x);
      if (progress === 1) this.#animation = null;
    }
    #stepMomentum(now) {
      const m = this.#momentum;
      if (!m) return;
      const dt = clamp(now - m.at, 0, 40);
      m.at = now;
      const wantLeft = this.#left + m.x * dt, wantTop = this.#top + m.y * dt;
      this.#left = wantLeft;
      this.#top = wantTop;
      this.#clampScroll();
      const decay = Math.exp(-dt / MOMENTUM_DECAY_MS);
      m.x = this.#left === wantLeft ? m.x * decay : 0; // an edge stops that axis
      m.y = this.#top === wantTop ? m.y * decay : 0;
      if (Math.hypot(m.x, m.y) < MOMENTUM_REST) this.#momentum = null;
    }
    // Dimensions and scroll offsets land in the same frame, so the drawing
    // window below uses the offsets the browser actually holds at this scale.
    // The camera keeps its fraction of a pixel (slow pans must accumulate);
    // an offset the browser already holds is not reassigned, which would cut
    // a native smooth scroll short.
    #commit() {
      const scroller = this.#scroller;
      this.#surface.style.width = this.#chartWidth + 'px';
      this.#surface.style.height = this.#chartHeight + 'px';
      if (Math.abs(scroller.scrollLeft - this.#left) >= 0.5) scroller.scrollLeft = this.#left;
      if (Math.abs(scroller.scrollTop - this.#top) >= 0.5) scroller.scrollTop = this.#top;
      this.#committedLeft = scroller.scrollLeft;
      this.#committedTop = scroller.scrollTop;
    }

    // ---- drawing ----

    // One retained SVG covers the viewport plus a bounded buffer. The large
    // scrollable surface is only a spacer, never a giant raster layer.
    #paint() {
      const padX = Math.min(WINDOW_PAD, this.#width / 4), padY = Math.min(WINDOW_PAD, this.#height / 4);
      const x = Math.max(0, Math.floor(this.#left - padX)), y = Math.max(0, Math.floor(this.#top - padY));
      const w = Math.min(this.#chartWidth - x, Math.ceil(this.#width + 2 * padX));
      const h = Math.min(this.#chartHeight - y, Math.ceil(this.#height + 2 * padY));
      setAttributes(this.#drawing, { width: w, height: h, viewBox: `${x} ${y} ${w} ${h}` });
      this.#drawing.style.left = x + 'px';
      this.#drawing.style.top = y + 'px';
      const marks = marksInWindow(this.#tracks, this.#tFor(x - LABEL_REACH), this.#tFor(x + w), y - LANE_REACH, y + h + LANE_REACH);
      this.#paintMarks(marks);
      this.#paintBands(x, y, w, h);
      const breaks = this.#axis.breaksIn(this.#tFor(x), this.#tFor(x + w));
      this.#paintBreaks(breaks, y, h);
      this.#paintTicks(x, y, w, h, breaks);
      const nowX = this.#xFor(this.#model.end);
      setAttributes(this.#nowLine, { x1: nowX, x2: nowX, y1: y, y2: y + h });
      this.#nowText.setAttribute('x', nowX + 6);
      return marks;
    }
    #paintMarks(marks) {
      const keep = new Set();
      const labelEnd = new Map(); // per track: where the last drawn label ends
      for (const mark of marks) {
        keep.add(mark.id);
        labelEnd.set(mark.y, this.#paintMark(this.#nodeFor(mark), mark, labelEnd.get(mark.y) ?? -Infinity));
      }
      for (const [id, node] of this.#nodes) {
        if (keep.has(id)) continue;
        // A focused mark stays mounted until focus leaves, even off-window.
        const focused = node.g.contains(document.activeElement) && this.#marksById.get(id);
        if (focused) { this.#paintMark(node, focused, -Infinity); continue; }
        node.g.remove();
        this.#nodes.delete(id);
      }
    }
    #nodeFor(mark) {
      const glyph = !!mark.glyph;
      let node = this.#nodes.get(mark.id);
      if (node && node.glyph !== glyph) { node.g.remove(); node = null; }
      if (!node) {
        const g = svg('g');
        const title = svg('title');
        const path = svg('path', { class: glyph ? '' : 'violin' });
        node = glyph ? { glyph, g, title, path, data: null } : {
          glyph, g, title, path, data: null,
          line: svg('line', { class: 'duration' }), text: svg('text'),
          dot: svg('circle', { r: 3.5 }), active: svg('rect', { class: 'activeframe' }),
        };
        g.append(title, ...(glyph ? [path] : [node.line, path, node.text, node.dot, node.active]));
        g.style.pointerEvents = 'auto'; // the drawing itself lets events through
        this.#markLayer.append(g);
        this.#nodes.set(mark.id, node);
      }
      return node;
    }
    // Everything that does not move with the camera, applied once per data object.
    #applyMarkIdentity(node, mark) {
      const { g, title, path } = node;
      for (const attr of [...g.attributes]) if (attr.name.startsWith('data-')) g.removeAttribute(attr.name);
      setAttributes(g, { class: mark.className || 'tmark', tabindex: 0, ...mark.attributes });
      // Text is only written when it changed: a new data object with the
      // same words must not dirty the page (on e-ink, a screen refresh).
      // `title` may be a getter the caller computes lazily: read it once.
      const tip = mark.title || '';
      if (title.textContent !== tip) title.textContent = tip;
      path.style.fill = mark.color?.fill || '';
      if (!node.glyph) {
        path.style.stroke = mark.color?.stroke || '';
        node.line.style.stroke = mark.color?.stroke || '';
        const label = mark.label || '';
        if (node.text.textContent !== label) node.text.textContent = label;
        node.dot.setAttribute('class', 'livedot' + (mark.working ? '' : ' idle'));
        node.dot.style.display = mark.live || mark.working ? '' : 'none';
        node.active.style.display = mark.active ? '' : 'none';
      }
      node.data = mark;
    }
    // Returns where the next label on this track may start.
    #paintMark(node, mark, labelRight) {
      if (node.data !== mark) this.#applyMarkIdentity(node, mark);
      const x0 = this.#xFor(mark.start);
      const x1 = Math.max(x0 + (mark.minWidth ?? MIN_MARK_WIDTH), this.#xFor(mark.end));
      const y = mark.y;
      mark.x0 = x0; mark.x1 = x1; // hit testing reads the geometry that was drawn
      if (node.glyph) {
        node.path.setAttribute('d', (GLYPHS[mark.glyph] || GLYPHS.square)(x0, y));
        return labelRight;
      }
      const { line, path, text, dot, active } = node;
      setAttributes(line, { x1: x0, x2: x1, y1: y, y2: y });
      let upper = '', lower = '';
      for (const [u, amplitude] of mark.points) {
        const px = x0 + u * (x1 - x0);
        upper += `L${px},${y - amplitude}`;
        lower = `L${px},${y + amplitude}` + lower;
      }
      path.setAttribute('d', `M${x0},${y}${upper}L${x1},${y}${lower}Z`);
      // Overlapping titles are dropped rather than measured every frame or
      // pushed into another lane. The full title stays in the tooltip.
      const showLabel = !!mark.label && this.#scale >= (mark.labelMinScale ?? 40) && x0 >= labelRight;
      text.style.display = showLabel ? '' : 'none';
      setAttributes(text, { x: x0, y: y - 10 });
      setAttributes(dot, { cx: x1, cy: y });
      const laneHeight = mark.laneHeight || 32;
      setAttributes(active, { x: x0 - 3, y: y - laneHeight / 2 + 1, width: x1 - x0 + 6, height: laneHeight - 2 });
      return showLabel ? x0 + mark.label.length * (mark.labelCharWidth ?? LABEL_CHAR_PX) + LABEL_GAP : labelRight;
    }
    #paintBands(x, y, w, h) {
      const keep = new Set();
      for (const band of this.#model.bands) {
        if (band.y + band.height < y || band.y > y + h) continue;
        keep.add(band.key);
        let node = this.#bandNodes.get(band.key);
        if (!node) {
          node = { rect: svg('rect'), line: svg('line', { class: 'timeline-band-edge' }) };
          this.#bandLayer.append(node.rect, node.line);
          this.#bandNodes.set(band.key, node);
        }
        setAttributes(node.rect, { class: band.className || 'timeline-band', x, y: band.y, width: w, height: band.height });
        setAttributes(node.line, { x1: x, x2: x + w, y1: band.y + band.height, y2: band.y + band.height });
      }
      for (const [key, node] of this.#bandNodes) {
        if (keep.has(key)) continue;
        node.rect.remove(); node.line.remove();
        this.#bandNodes.delete(key);
      }
    }
    // A break is quiet time drawn narrower than to scale: a faint band with a
    // zigzag seam, and how long it stands for in the date strip.
    #paintBreaks(breaks, y, h) {
      const keep = new Set();
      for (const brk of breaks) {
        keep.add(brk.start);
        let node = this.#breakNodes.get(brk.start);
        if (!node) {
          node = { group: svg('g', { class: 'tbreak' }), rect: svg('rect'), seam: svg('path'), text: svg('text', { y: 11, 'text-anchor': 'middle' }), title: svg('title') };
          node.group.append(node.title, node.rect, node.seam, node.text);
          this.#breakLayer.append(node.group);
          this.#breakNodes.set(brk.start, node);
        }
        const x0 = this.#lead + brk.x, mid = x0 + brk.width / 2, label = quietLabel(brk.end - brk.start);
        setAttributes(node.rect, { x: x0, y, width: brk.width, height: h });
        let d = `M${mid},${y}`;
        for (let yy = y, k = 0; yy < y + h; yy += 6, k++) d += `L${mid + (k % 2 ? -3 : 3)},${yy + 6}`;
        node.seam.setAttribute('d', d);
        node.text.setAttribute('x', mid);
        // Too narrow to say while it is still being squeezed: the tooltip says it.
        node.text.textContent = brk.width >= BREAK_PX - 0.5 ? label : '';
        const quiet = 'Nothing happened for ' + label;
        if (node.title.textContent !== quiet) node.title.textContent = quiet;
      }
      for (const [key, node] of this.#breakNodes) {
        if (keep.has(key)) continue;
        node.group.remove();
        this.#breakNodes.delete(key);
      }
    }
    // Grid lines for the stretches of time drawn to scale; none inside a break.
    #paintTicks(x, y, w, h, breaks) {
      const keep = new Set();
      const segments = [];
      let from = this.#tFor(x);
      for (const brk of breaks) {
        if (brk.start > from) segments.push([from, brk.start]);
        from = Math.max(from, brk.end);
      }
      const to = this.#tFor(x + w);
      if (to > from) segments.push([from, to]);
      const ticks = segments.flatMap(([a, b]) => calendarTicks(a, b, this.#scale).filter(tick => tick.time >= a && tick.time <= b));
      // A date label that would run into a break's label gives way to it.
      const quietLabels = breaks.map(brk => this.#lead + brk.x);
      const crowds = tx => quietLabels.some(bx => tx > bx - 34 && tx < bx + BREAK_PX);
      for (const tick of ticks) {
        keep.add(tick.time);
        let node = this.#tickNodes.get(tick.time);
        if (!node) {
          node = { group: svg('g'), line: svg('line'), text: svg('text', { y: 11 }) };
          node.group.append(node.line, node.text);
          this.#tickLayer.append(node.group);
          this.#tickNodes.set(tick.time, node);
        }
        const tx = this.#xFor(tick.time);
        setAttributes(node.group, { class: tick.major ? 'tday major' : 'tday' });
        setAttributes(node.line, { x1: tx, x2: tx, y1: y, y2: y + h });
        setAttributes(node.text, { x: tx + 4 });
        const label = crowds(tx) ? '' : tick.label;
        if (node.text.textContent !== label) node.text.textContent = label;
      }
      for (const [time, node] of this.#tickNodes) {
        if (keep.has(time)) continue;
        node.group.remove();
        this.#tickNodes.delete(time);
      }
    }

    // ---- input ----

    #onScroll() {
      const scroller = this.#scroller;
      if (scroller.scrollLeft === this.#committedLeft && scroller.scrollTop === this.#committedTop) return; // our own commit
      this.#interrupt();
      this.#schedule();
      this.#settle();
    }
    #onWheel(e) {
      if (!this.#model) return;
      const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? this.#height : 1;
      if (e.ctrlKey || e.metaKey) {
        // Mouse notches and trackpad pinches (reported as Ctrl+wheel) share one
        // proportional, briefly interpolated response. No device guessing.
        e.preventDefault();
        const factor = Math.exp(clamp(-e.deltaY * unit * WHEEL_ZOOM_RATE, -1, 1));
        this.zoomBy(factor, { clientX: e.clientX, animate: true, duration: WHEEL_ZOOM_MS });
        return;
      }
      this.#interrupt();
      if (e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        this.#left += e.deltaY * unit;
        this.#clampScroll();
        this.#schedule();
        this.#settle();
      }
      // Plain wheel and trackpad scrolling stay native, inertia included.
    }
    #touchCentroid() {
      const points = [...this.#pointers.values()].slice(0, 2);
      if (!points.length) return null;
      return {
        x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
        y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
        distance: points.length === 2 ? Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) : 0,
      };
    }
    // Touch owns panning as well as pinching (the scroller has touch-action:
    // none), so one finger and two fingers cannot be split between the chart
    // and the browser mid-gesture. Mouse drags are left to the caller.
    #onPointerDown(e) {
      if (!this.#model || e.pointerType !== 'touch' || e.target.closest(CONTROL_SELECTOR)) return;
      this.#interrupt();
      this.#pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.#pointers.size === 1) { this.#dragged = this.#pinched = false; this.#velocity = { x: 0, y: 0 }; }
      else this.#dragged = this.#pinched = true;
      this.#gesture = this.#touchCentroid();
      this.#sampleTime = e.timeStamp;
    }
    #onPointerMove(e) {
      const pointer = this.#pointers.get(e.pointerId);
      if (!pointer) return;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      const previous = this.#gesture, next = this.#touchCentroid();
      const dx = next.x - previous.x, dy = next.y - previous.y;
      if (!this.#dragged && Math.hypot(dx, dy) < TAP_SLOP) return; // still a possible tap
      this.#dragged = true;
      // Capture starts with the drag, not the touch: a tap must still land on the mark under it.
      for (const id of this.#pointers.keys()) if (!this.#scroller.hasPointerCapture(id)) this.#scroller.setPointerCapture(id);
      const rect = this.#scroller.getBoundingClientRect();
      const fromX = previous.x - rect.left - this.#scroller.clientLeft;
      const toX = next.x - rect.left - this.#scroller.clientLeft;
      if (this.#pointers.size >= 2 && previous.distance > 0 && next.distance > 0) {
        // The time under the old midpoint moves to the new midpoint: pan and zoom together.
        this.#applyScale(this.#scale * next.distance / previous.distance, this.#tFor(this.#left + fromX), toX);
      } else this.#left -= dx;
      this.#top -= dy;
      const dt = e.timeStamp - this.#sampleTime;
      if (dt > 0) this.#velocity = { x: -dx / Math.max(8, dt), y: -dy / Math.max(8, dt) };
      this.#sampleTime = e.timeStamp;
      this.#gesture = next;
      this.#clampScroll();
      this.#options.onInteract();
      this.#schedule();
      this.#settle();
    }
    #onPointerEnd(e) {
      if (!this.#pointers.delete(e.pointerId)) return;
      if (this.#scroller.hasPointerCapture(e.pointerId)) this.#scroller.releasePointerCapture(e.pointerId);
      if (this.#dragged) this.#suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;
      this.#gesture = this.#touchCentroid();
      if (this.#pointers.size) return;
      const flick = this.#dragged && !this.#pinched && e.type === 'pointerup' && e.timeStamp - this.#sampleTime < FLICK_WINDOW_MS;
      if (flick) { this.#momentum = { ...this.#velocity, at: performance.now() }; this.#schedule(); }
      this.#flushDeferredData();
      this.#settle();
    }
  }

  return TimelineChart;
});

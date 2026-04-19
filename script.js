'use strict';

// ─── Canvas setup ────────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const wrap = document.getElementById('canvas-wrap');
const pCanvas = document.getElementById('pareto-canvas');
const pCtx = pCanvas.getContext('2d');

// ─── State ───────────────────────────────────────────────────────────────────
let depot = null;
let points = [];
let mode = 'depot';
let animating = false;
let mstEdges = [];
let currentK = 1;
let paused = false;
let pauseResolver = null;
let paretoPoints = [];   // { k, makespan }

// ─── Robot colors (up to 10) ─────────────────────────────────────────────────
const ROBOT_COLORS = [
  '#7c6cff', '#4dffa0', '#ff6c8a', '#ffb84d', '#4dc8ff',
  '#ff4df7', '#a0ff4d', '#ff8c4d', '#4dffed', '#c84dff'
];
const ROBOT_GLOW = [
  'rgba(124,108,255,0.35)', 'rgba(77,255,160,0.35)', 'rgba(255,108,138,0.35)',
  'rgba(255,184,77,0.35)',  'rgba(77,200,255,0.35)', 'rgba(255,77,247,0.35)',
  'rgba(160,255,77,0.35)',  'rgba(255,140,77,0.35)', 'rgba(77,255,237,0.35)',
  'rgba(200,77,255,0.35)'
];

// ─── Resize ───────────────────────────────────────────────────────────────────
function resize() {
  const r = wrap.getBoundingClientRect();
  canvas.width = r.width;
  canvas.height = r.height;
  redraw();
}
window.addEventListener('resize', resize);
setTimeout(resize, 50);

// ─── Mode ─────────────────────────────────────────────────────────────────────
function setMode(m) {
  mode = m;
  document.getElementById('btn-depot').classList.toggle('active', m === 'depot');
  document.getElementById('btn-point').classList.toggle('active', m === 'point');
}

// ─── K slider ─────────────────────────────────────────────────────────────────
function onKChange(val) {
  currentK = parseInt(val);
  document.getElementById('stat-k').textContent = currentK;
  const n = points.length;
  document.getElementById('k-desc').textContent =
    currentK === 1
      ? '1 robot'
      : `${currentK} robots`;
}

function updateKMax() {
  const maxK = Math.max(1, points.length);
  const slider = document.getElementById('k-slider');
  slider.max = maxK;
  document.getElementById('k-max-label').textContent = maxK;
  if (currentK > maxK) {
    currentK = maxK;
    slider.value = maxK;
    document.getElementById('stat-k').textContent = maxK;
  }
}

// ─── Click to place ───────────────────────────────────────────────────────────
canvas.addEventListener('click', e => {
  if (animating) return;
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;

  if (mode === 'depot') {
    depot = { x, y };
    document.getElementById('overlay').classList.add('hidden');
    setMode('point');
    setStatus('depot placed — add delivery stops', '');
  } else {
    if (!depot) { setMode('depot'); return; }
    points.push({ x, y });
    document.getElementById('stat-stops').textContent = points.length;
    updateKMax();
  }

  mstEdges = [];
  document.getElementById('stat-dist').textContent = '—';
  document.getElementById('stat-total').textContent = '—';
  document.getElementById('btn-run').disabled = (points.length < 2);
  resetPhases();
  redraw();
});

// ─── Clear ────────────────────────────────────────────────────────────────────
function clearAll() {
  if (animating) return;
  depot = null; points = []; mstEdges = [];
  document.getElementById('overlay').classList.remove('hidden');
  document.getElementById('stat-stops').textContent = '0';
  document.getElementById('stat-dist').textContent = '—';
  document.getElementById('stat-total').textContent = '—';
  document.getElementById('stat-k').textContent = '1';
  document.getElementById('btn-run').disabled = true;
  document.getElementById('k-slider').value = 1;
  currentK = 1;
  updateKMax();
  resetPhases();
  clearRobotLegend();
  setStatus('place a depot to begin', '');
  setMode('depot');
  redraw();
}

function clearPareto() {
  paretoPoints = [];
  drawPareto();
  document.getElementById('pareto-hint').textContent =
    'run the solver at different K values to build the frontier';
}

// ─── Status ───────────────────────────────────────────────────────────────────
function setStatus(msg, cls) {
  const el = document.getElementById('status-bar');
  el.className = cls || '';
  el.innerHTML = cls === 'active'
    ? `<span class="running-dot"></span>${msg}`
    : msg;
}

// ─── Phase helpers ────────────────────────────────────────────────────────────
function resetPhases() {
  for (let i = 0; i <= 5; i++) {
    const el = document.getElementById(`phase-${i}`);
    el.classList.remove('active', 'done');
  }
}
function setPhase(i, state) {
  const el = document.getElementById(`phase-${i}`);
  el.classList.remove('active', 'done');
  if (state) el.classList.add(state);
}

// ─── Geometry ─────────────────────────────────────────────────────────────────
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function allNodes() { return depot ? [depot, ...points] : points; }

// ─── 2-Opt Optimization ──────────────────────────────────────────────────────
function optimize2Opt(nodes, tour) {
  let improved = true;
  let newTour = [...tour];
  const n = newTour.length;

  // Continue until no more improvements (crossings) are found
  while (improved) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        // Current edges: (i-1, i) and (j, j+1 mod n)
        const a = nodes[newTour[i - 1]];
        const b = nodes[newTour[i]];
        const c = nodes[newTour[j]];
        const d = nodes[newTour[(j + 1) % n]];

        // If distance(a,c) + distance(b,d) < distance(a,b) + distance(c,d)
        // then the edges cross or are sub-optimal.
        const currentDist = dist(a, b) + dist(c, d);
        const newDist = dist(a, c) + dist(b, d);

        if (newDist < currentDist - 0.01) { // 0.01 to avoid floating point loops
          // Reverse the segment from i to j
          const segment = newTour.slice(i, j + 1).reverse();
          newTour.splice(i, j - i + 1, ...segment);
          improved = true;
        }
      }
    }
  }
  return newTour;
}

// ─── Prim's MST ───────────────────────────────────────────────────────────────
function buildMST(nodes) {
  const n = nodes.length;
  const inTree = new Set([0]);
  const edges = [];
  while (inTree.size < n) {
    let best = null, bd = Infinity;
    for (const u of inTree) {
      for (let v = 0; v < n; v++) {
        if (inTree.has(v)) continue;
        const d = dist(nodes[u], nodes[v]);
        if (d < bd) { bd = d; best = { u, v, d }; }
      }
    }
    edges.push(best);
    inTree.add(best.v);
  }
  return edges;
}

function splitTour(nodes, tour, K) {
  const deliveries = tour.slice(1); // remove depot (0)
  const n = deliveries.length;

  const subsets = [];
  const chunkSize = Math.ceil(n / K);

  for (let i = 0; i < K; i++) {
    const chunk = deliveries.slice(i * chunkSize, (i + 1) * chunkSize);
    if (chunk.length > 0) {
      subsets.push([0, ...chunk]); // add depot back
    }
  }

  return subsets;
}

// Nearest-neighbor tour through a subset of nodes, starting from depot (idx 0).
// Much better sub-tour quality than DFS walk order.
function subtourNN(nodes, subset) {
  const deliveries = subset.filter(v => v !== 0);
  if (deliveries.length === 0) return [0];

  const unvisited = new Set(deliveries);
  const order = [0]; // start at depot
  let current = 0;

  while (unvisited.size > 0) {
    let nearest = null, nd = Infinity;
    for (const v of unvisited) {
      const d = dist(nodes[current], nodes[v]);
      if (d < nd) { nd = d; nearest = v; }
    }
    unvisited.delete(nearest);
    order.push(nearest);
    current = nearest;
  }
  return optimize2Opt(nodes, order);
}

async function animate2Opt(nodes, tour, robotColor) {
  let improved = true;
  let currentTour = [...tour];
  const delay = () => sleep(getDelay());

  while (improved) {
    improved = false;
    for (let i = 1; i < currentTour.length - 1; i++) {
      for (let j = i + 1; j < currentTour.length; j++) {
        const a = nodes[currentTour[i - 1]];
        const b = nodes[currentTour[i]];
        const c = nodes[currentTour[j]];
        const d = nodes[currentTour[(j + 1) % currentTour.length]];

        if (dist(a, c) + dist(b, d) < dist(a, b) + dist(c, d) - 0.01) {
          // Perform swap
          const segment = currentTour.slice(i, j + 1).reverse();
          currentTour.splice(i, j - i + 1, ...segment);
          
          // Visualize the swap
          redraw({ 
            mst: mstEdges, 
            subtours: [{ order: currentTour, color: robotColor }] 
          });
          
          // Flash the new edges in a highlight color
          drawEdge(a, c, '#ffffff', 3, 1);
          drawEdge(b, d, '#ffffff', 3, 1);
          
          await delay();
          improved = true;
          break; 
        }
      }
      if (improved) break;
    }
  }
  return currentTour;
}

// Compute tour distance (including return to start)
function tourDistance(nodes, tourOrder) {
  let d = 0;
  for (let i = 0; i < tourOrder.length - 1; i++)
    d += dist(nodes[tourOrder[i]], nodes[tourOrder[i + 1]]);
  d += dist(nodes[tourOrder[tourOrder.length - 1]], nodes[tourOrder[0]]);
  return d;
}

// ─── Sleep ────────────────────────────────────────────────────────────────────
async function sleep(ms) {
  const start = Date.now();

  while (Date.now() - start < ms) {
    if (paused) {
      await new Promise(resolve => (pauseResolver = resolve));
    }
    await new Promise(r => setTimeout(r, 10));
  }
}

function getDelay() {
  const s = parseInt(document.getElementById('speed').value);
  return [0, 700, 380, 200, 90, 25][s];
}

function togglePause() {
  paused = !paused;

  const btn = document.getElementById('btn-pause');
  btn.textContent = paused ? 'Resume' : 'Pause';

  // if resuming, unblock the animation
  if (!paused && pauseResolver) {
    pauseResolver();
    pauseResolver = null;
  }
}

// ─── Draw helpers ─────────────────────────────────────────────────────────────
function drawDepot(x, y) {
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffb84d'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fillStyle = '#ffb84d'; ctx.fill();
  ctx.fillStyle = '#0a0a0f';
  ctx.font = 'bold 9px "DM Mono", monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('D', x, y);
  ctx.restore();
}

function drawPoint(x, y, label, color = '#7c6cff', size = 7) {
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '9px "DM Mono", monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y - 14);
  ctx.restore();
}

function drawEdge(a, b, color, width, alpha, dash = []) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.setLineDash(dash); ctx.stroke();
  ctx.restore();
}

function drawArrow(a, b, color, width, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) { ctx.restore(); return; }
  const ux = dx / len, uy = dy / len;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x - ux * 10, b.y - uy * 10);
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(b.x - ux * 10, b.y - uy * 10);
  ctx.lineTo(b.x - ux * 17 + uy * 5, b.y - uy * 17 - ux * 5);
  ctx.lineTo(b.x - ux * 17 - uy * 5, b.y - uy * 17 + ux * 5);
  ctx.closePath(); ctx.fillStyle = color; ctx.fill();
  ctx.restore();
}

// ─── Full redraw (static state) ───────────────────────────────────────────────
function redraw(opts = {}) {
  const {
    mst = [],
    subtours = [],   // array of { order, color } — each robot's tour
    highlightEdge = -1,
    showDoubled = false,
    showMST = true,
    eulerEdges = [],
  } = opts;

  const nodes = allNodes();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // MST edges
  if (showMST) {
    for (const e of mst) {
      const a = nodes[e.u], b = nodes[e.v];
      drawEdge(a, b, 'rgba(124,108,255,0.25)', 1.5, 1);
    }
  }

  // Doubled edges (phase 1)
  if (showDoubled) {
    for (const e of mst) {
      const a = nodes[e.u], b = nodes[e.v];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const nx = -dy / len * 3, ny = dx / len * 3;
      ctx.save(); ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.moveTo(a.x + nx, a.y + ny); ctx.lineTo(b.x + nx, b.y + ny);
      ctx.strokeStyle = '#ff6c8a'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]); ctx.stroke();
      ctx.restore();
    }
  }

  // Euler walk edges
  for (let i = 0; i < eulerEdges.length; i++) {
    const [u, v] = eulerEdges[i];
    const a = nodes[u], b = nodes[v];
    drawEdge(a, b, 'rgba(255,184,77,0.55)', 1.5, 1, [3, 3]);
  }

  // Robot sub-tours
  for (const { order, color } of subtours) {
    if (order.length < 2) continue;
    const full = [...order, order[0]];
    for (let i = 0; i < full.length - 1; i++) {
      const a = nodes[full[i]], b = nodes[full[i + 1]];
      drawArrow(a, b, color, 2, 0.85);
    }
  }

  // Delivery points
  points.forEach((p, i) => {
    // Find which robot owns this point
    let color = '#7c6cff';
    for (const { order, color: c } of subtours) {
      if (order.includes(i + 1)) { color = c; break; }
    }
    drawPoint(p.x, p.y, i + 1, color);
  });

  // Depot
  if (depot) drawDepot(depot.x, depot.y);
}

// ─── Robot legend ─────────────────────────────────────────────────────────────
function updateRobotLegend(subtours) {
  const nodes = allNodes();
  
  // Inject legend below K slider
  let el = document.getElementById('robot-legend');
  if (!el) {
    el = document.createElement('div');
    el.id = 'robot-legend';
    el.className = 'robot-legend';
    document.getElementById('k-slider').closest('.panel').appendChild(el);
  }

  el.innerHTML = subtours.map((s, i) => {
    const stopCount = s.order.filter(v => v !== 0).length;
    const distance = Math.round(tourDistance(nodes, s.order));
    
    return `
      <div class="robot-tag">
        <span class="robot-swatch" style="background:${s.color}"></span>
        R${i + 1} · ${stopCount} stops · ${distance} units
      </div>`;
  }).join('');
}

function clearRobotLegend() {
  const el = document.getElementById('robot-legend');
  if (el) el.innerHTML = '';
}

// ─── Pareto frontier ──────────────────────────────────────────────────────────
function recordPareto(k, makespan) {
  // Keep only the best (lowest) makespan per K
  const existing = paretoPoints.find(p => p.k === k);
  if (existing) {
    if (makespan < existing.makespan) existing.makespan = makespan;
  } else {
    paretoPoints.push({ k, makespan });
  }
  paretoPoints.sort((a, b) => a.k - b.k);
  drawPareto();
}

function drawPareto() {
  const W = pCanvas.width, H = pCanvas.height;
  pCtx.clearRect(0, 0, W, H);

  const pad = { l: 44, r: 20, t: 16, b: 36 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  // Background
  pCtx.fillStyle = '#1a1a24';
  pCtx.beginPath();
  pCtx.roundRect(0, 0, W, H, 6);
  pCtx.fill();

  if (paretoPoints.length === 0) {
    pCtx.fillStyle = '#6b6b80';
    pCtx.font = '11px "DM Mono", monospace';
    pCtx.textAlign = 'center';
    pCtx.fillText('no data yet — run solver to plot points', W / 2, H / 2);
    return;
  }

  const kVals = paretoPoints.map(p => p.k);
  const msVals = paretoPoints.map(p => p.makespan);
  const minK = 1, maxK = Math.max(...kVals, 2);
  const minMs = 0, maxMs = Math.max(...msVals) * 1.15;

  function px(k) { return pad.l + ((k - minK) / (maxK - minK || 1)) * iw; }
  function py(ms) { return pad.t + ih - ((ms - minMs) / (maxMs - minMs || 1)) * ih; }

  // Grid lines
  pCtx.strokeStyle = 'rgba(255,255,255,0.05)';
  pCtx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ih / 4) * i;
    pCtx.beginPath(); pCtx.moveTo(pad.l, y); pCtx.lineTo(pad.l + iw, y); pCtx.stroke();
    const val = Math.round(maxMs - (maxMs / 4) * i);
    pCtx.fillStyle = '#6b6b80';
    pCtx.font = '9px "DM Mono", monospace';
    pCtx.textAlign = 'right';
    pCtx.fillText(val, pad.l - 5, y + 3);
  }

  // X axis labels
  pCtx.textAlign = 'center';
  pCtx.fillStyle = '#6b6b80';
  pCtx.font = '9px "DM Mono", monospace';
  paretoPoints.forEach(p => {
    pCtx.fillText(`K=${p.k}`, px(p.k), pad.t + ih + 18);
  });

  // Axis labels
  pCtx.fillStyle = '#6b6b80';
  pCtx.font = '10px "DM Mono", monospace';
  pCtx.textAlign = 'center';
  pCtx.fillText('robots (K)', pad.l + iw / 2, H - 4);
  pCtx.save();
  pCtx.translate(11, pad.t + ih / 2);
  pCtx.rotate(-Math.PI / 2);
  pCtx.fillText('makespan', 0, 0);
  pCtx.restore();

  // Connecting line
  if (paretoPoints.length > 1) {
    pCtx.beginPath();
    pCtx.moveTo(px(paretoPoints[0].k), py(paretoPoints[0].makespan));
    for (let i = 1; i < paretoPoints.length; i++) {
      pCtx.lineTo(px(paretoPoints[i].k), py(paretoPoints[i].makespan));
    }
    pCtx.strokeStyle = 'rgba(124,108,255,0.4)';
    pCtx.lineWidth = 1.5;
    pCtx.setLineDash([4, 4]);
    pCtx.stroke();
    pCtx.setLineDash([]);
  }

  // Points
  paretoPoints.forEach((p, i) => {
    const x = px(p.k), y = py(p.makespan);
    const color = ROBOT_COLORS[(p.k - 1) % ROBOT_COLORS.length];
    // glow
    pCtx.beginPath(); pCtx.arc(x, y, 7, 0, Math.PI * 2);
    pCtx.fillStyle = color.replace(')', ', 0.2)').replace('rgb', 'rgba'); pCtx.fill();
    // dot
    pCtx.beginPath(); pCtx.arc(x, y, 4, 0, Math.PI * 2);
    pCtx.fillStyle = color; pCtx.fill();
    // value label
    pCtx.fillStyle = color;
    pCtx.font = '10px "DM Mono", monospace';
    pCtx.textAlign = 'center';
    pCtx.fillText(Math.round(p.makespan), x, y - 12);
  });

  document.getElementById('pareto-hint').textContent =
    `${paretoPoints.length} point${paretoPoints.length !== 1 ? 's' : ''} plotted — change K and run again to extend`;
}

// Resize pareto canvas
function resizePareto() {
  const w = pCanvas.parentElement.getBoundingClientRect().width - 32;
  pCanvas.width = Math.max(w, 200);
  drawPareto();
}
window.addEventListener('resize', resizePareto);
setTimeout(resizePareto, 80);

// ─── Main solve ───────────────────────────────────────────────────────────────
async function runSolve() {
  if (animating || !depot || points.length < 2) return;
  animating = true;
  document.getElementById('btn-run').disabled = true;
  resetPhases();
  clearRobotLegend();
  document.getElementById('stat-dist').textContent = '—';
  document.getElementById('stat-total').textContent = '—';

  const nodes = allNodes();
  const K = currentK;
  const delay = () => sleep(getDelay());

  // ── Phase 0: Build MST ───────────────────────────────────────────────────
  setPhase(0, 'active');
  setStatus('building minimum spanning tree…', 'active');

  const builtEdges = [];
  const inTree = new Set([0]);
  redraw();
  await delay();

  while (inTree.size < nodes.length) {
    let best = null, bd = Infinity;
    for (const u of inTree) {
      for (let v = 0; v < nodes.length; v++) {
        if (inTree.has(v)) continue;
        const d = dist(nodes[u], nodes[v]);
        if (d < bd) { bd = d; best = { u, v, d }; }
      }
    }
    builtEdges.push(best);
    inTree.add(best.v);

    redraw({ mst: builtEdges });
    // Flash new edge
    const a = nodes[best.u], b = nodes[best.v];
    ctx.save(); ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = '#7c6cff'; ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();
    await delay();
  }

  mstEdges = builtEdges;
  setPhase(0, 'done');
  await sleep(150);

  // ── Phase 1: Double edges ────────────────────────────────────────────────
  setPhase(1, 'active');
  setStatus('doubling all MST edges…', 'active');
  redraw({ mst: mstEdges, showDoubled: true });
  await sleep(getDelay() * 2 + 200);
  setPhase(1, 'done');
  await sleep(150);

  // ── Phase 2: Euler walk (DFS preorder on full MST) ───────────────────────
  setPhase(2, 'active');
  setStatus('computing Euler walk via DFS…', 'active');

  const adj = Array.from({ length: nodes.length }, () => []);
  for (const e of mstEdges) { adj[e.u].push(e.v); adj[e.v].push(e.u); }
  const visited0 = new Set();
  const walkOrder = [];
  function dfs0(v) { visited0.add(v); walkOrder.push(v); for (const nb of adj[v]) if (!visited0.has(nb)) dfs0(nb); }
  dfs0(0);

  const eulerAnim = [];
  for (let i = 0; i < walkOrder.length - 1; i++) {
    eulerAnim.push([walkOrder[i], walkOrder[i + 1]]);
    redraw({ mst: mstEdges, eulerEdges: [...eulerAnim] });
    // Highlight current node
    const nd = nodes[walkOrder[i + 1]];
    ctx.save(); ctx.beginPath(); ctx.arc(nd.x, nd.y, 11, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffb84d'; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.6; ctx.stroke();
    ctx.restore();
    await delay();
  }

  setPhase(2, 'done');
  await sleep(150);

  // ── Phase 3: Shortcut to Hamiltonian tour ───────────────────────────────
  setPhase(3, 'active');
  setStatus('shortcutting repeated visits…', 'active');

  let shortcut = [...new Set(walkOrder)];
  // Animate building the shortcut tour
  const buildingTour = [{ order: [shortcut[0]], color: ROBOT_COLORS[0] }];
  for (let i = 1; i < shortcut.length; i++) {
    buildingTour[0].order = shortcut.slice(0, i + 1);
    redraw({ mst: mstEdges, subtours: buildingTour });
    await delay();
  }

  setPhase(3, 'done');
  await sleep(150);

  // ── Phase 4: 2-Opt Uncrossing  ─────────────────────────────────────
  setPhase(4, 'active');
  setStatus('eliminating edge crossings…', 'active');

  shortcut = await animate2Opt(nodes, shortcut, ROBOT_COLORS[0]);

  setPhase(4, 'done');
  await sleep(150);

  // ── Phase 5: K-decomposition ─────────────────────────────────────────────
  setPhase(5, 'active');
  if (K === 1) {
    setStatus('single robot — no decomposition needed', 'active');
  } else {
    setStatus(`decomposing into ${K} robot routes…`, 'active');
  }

  const subsets = splitTour(nodes, shortcut, K);

  // Animate each robot's route one by one
  const finalSubtours = [];
  for (let ri = 0; ri < subsets.length; ri++) {
    const color = ROBOT_COLORS[ri % ROBOT_COLORS.length];
    const order = subtourNN(nodes, subsets[ri]);
    finalSubtours.push({ order, color });

    // Animate this robot's path step by step
    for (let step = 2; step <= order.length; step++) {
      redraw({ mst: mstEdges, subtours: [
        ...finalSubtours.slice(0, ri),
        { order: order.slice(0, step), color },
        ...finalSubtours.slice(ri + 1)
      ]});
      await delay();
    }
    // Flash return-to-depot arc
    redraw({ mst: mstEdges, subtours: finalSubtours });
    await delay();
  }

  // Final render with cut edges highlighted
  redraw({ mst: mstEdges, subtours: finalSubtours, showMST: false });

  // Compute stats
  const subtourDists = finalSubtours.map(s => tourDistance(nodes, s.order));
  const makespan = Math.max(...subtourDists);
  const totalDist = subtourDists.reduce((a, b) => a + b, 0);

  document.getElementById('stat-dist').textContent = Math.round(makespan);
  document.getElementById('stat-total').textContent = Math.round(totalDist);

  setPhase(5, 'done');
  setStatus(
    K === 1
      ? `tour complete — makespan ${Math.round(makespan)} units`
      : `${K} robots — makespan ${Math.round(makespan)} · total ${Math.round(totalDist)}`,
    'done'
  );

  updateRobotLegend(finalSubtours);
  recordPareto(K, makespan);

  animating = false;
  document.getElementById('btn-run').disabled = false;
}
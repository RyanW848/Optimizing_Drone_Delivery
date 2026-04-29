"use strict";
// STATE
const map = document.getElementById("map");
const mctx = map.getContext("2d");
const pcan = document.getElementById("pareto");
const pctx = pcan.getContext("2d");
const wrap = map.parentElement;

let depot = null;
let pts = [];
let mode = "depot";
let algo = "A";
let K = 1;
let animating = false;
let paused = false;
let pauseResolve = null;

let frozenMST = null;
let frozenTour = null;

let paretoData = [];

const RC = [
  "#4488ff",
  "#3dff9a",
  "#ff4466",
  "#f5a623",
  "#cc44ff",
  "#ff884d",
  "#44ffee",
  "#ffee44",
  "#ff44bb",
  "#88ff44",
];

// Phase definitions per algo
const PHASES_A = [
  "Build MST (Prim's)",
  "DFS preorder tour",
  "2-opt convergence",
  "Binary search makespan X",
  "Greedy drone assignment",
  "Uncross tours",
];
const PHASES_B = [
  "Build MST (Prim's)",
  "Balanced K-cut",
  "NN tour per subtree",
  "Or-opt local polish",
];

// RESIZE
function resizeMap() {
  const r = wrap.getBoundingClientRect();
  map.width = r.width;
  map.height = r.height;
  redraw();
}
function resizePareto() {
  const pw = document.querySelector(".pareto-wrap");
  const r = pw.getBoundingClientRect();
  const sz = r.height - 14 - 8 - 18;
  pcan.width = r.width - 28;
  pcan.height = Math.max(sz, 180);
  drawPareto();
}
window.addEventListener("resize", () => {
  resizeMap();
  resizePareto();
});
setTimeout(() => {
  resizeMap();
  resizePareto();
  buildPhaseUI();
}, 60);

// ALGO SWITCH
function switchAlgo(a) {
  algo = a;
  document.getElementById("btnA").classList.toggle("active", a === "A");
  document.getElementById("btnB").classList.toggle("active", a === "B");
  document.getElementById("algolabel").textContent =
    a === "A"
      ? "Method A · MST + DFS + 2-opt → binary split + uncross"
      : "Method B · MST → balanced K-cut → NN + Or-opt";
  buildPhaseUI();
}

// PHASES UI
function buildPhaseUI() {
  const phases = algo === "A" ? PHASES_A : PHASES_B;
  const el = document.getElementById("phases");
  el.innerHTML = phases
    .map(
      (p, i) =>
        `<div class="pitem" id="ph${i}"><span class="pdot"></span>${p}</div>`,
    )
    .join("");
}
function resetPhases() {
  document
    .querySelectorAll(".pitem")
    .forEach((e) => e.classList.remove("active", "done"));
}
function setPhase(i, state) {
  const el = document.getElementById(`ph${i}`);
  if (!el) return;
  el.classList.remove("active", "done");
  if (state) el.classList.add(state);
}

function setMode(m) {
  mode = m;
  document.getElementById("mDepot").classList.toggle("active", m === "depot");
  document.getElementById("mPoint").classList.toggle("active", m === "point");
}

map.addEventListener("click", (e) => {
  if (animating) return;
  const r = map.getBoundingClientRect();
  const x = e.clientX - r.left,
    y = e.clientY - r.top;

  if (mode === "depot") {
    depot = { x, y };
    document.getElementById("hint").classList.add("gone");
    setMode("point");
    setStatus("depot placed — add stops", "");
  } else {
    if (!depot) {
      setMode("depot");
      return;
    }
    pts.push({ x, y });
    document.getElementById("sv-stops").textContent = pts.length;
    updateKMax();
  }
  frozenMST = null;
  frozenTour = null;
  document.getElementById("sv-makespan").textContent = "—";
  document.getElementById("sv-total").textContent = "—";
  document.getElementById("btnRun").disabled = pts.length < 2;
  resetPhases();
  redraw();
});

function onK(v) {
  K = v;
  document.getElementById("kval").textContent = K;
  document.getElementById("sv-k").textContent = K;
  document.getElementById("ksub").textContent =
    K === 1 ? "1 drone" : `${K} drones`;
}
function updateKMax() {
  const sl = document.getElementById("kslider");
  const mx = Math.max(1, pts.length);
  sl.max = mx;
  if (K > mx) {
    K = mx;
    sl.value = mx;
    onK(mx);
  }
}

function clearAll() {
  if (animating) return;
  depot = null;
  pts = [];
  frozenMST = null;
  frozenTour = null;
  K = 1;
  document.getElementById("kslider").value = 1;
  onK(1);
  document.getElementById("sv-stops").textContent = "0";
  document.getElementById("sv-makespan").textContent = "—";
  document.getElementById("sv-total").textContent = "—";
  document.getElementById("btnRun").disabled = true;
  document.getElementById("hint").classList.remove("gone");
  document.getElementById("dronelist").innerHTML = "";
  resetPhases();
  setStatus("place a depot to begin", "");
  setMode("depot");
  redraw();
}
function clearPareto() {
  paretoData = [];
  drawPareto();
  document.getElementById("statusbar").textContent =
    "run solver at different K values to build frontier";
}

function setStatus(msg, cls) {
  const el = document.getElementById("statusbar");
  el.className = cls || "";
  el.innerHTML =
    cls === "running" ? `<span class="dot-run"></span>${msg}` : msg;
}

function togglePause() {
  paused = !paused;
  const btn = document.getElementById("pausebtn");
  btn.textContent = paused ? "▶ resume" : "⏸ pause";
  btn.classList.toggle("paused", paused);
  if (!paused && pauseResolve) {
    pauseResolve();
    pauseResolve = null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function tick() {
  if (paused) {
    await new Promise((r) => {
      pauseResolve = r;
    });
  }
}
function delay() {
  const s = +document.getElementById("speed").value;
  return [0, 800, 450, 220, 100, 40, 8][s];
}
async function wait(extra = 0) {
  await tick();
  if (delay() > 0) await sleep(delay() + extra);
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function allNodes() {
  return depot ? [depot, ...pts] : pts;
}

// PRIM'S MST
function buildMST(nodes) {
  const n = nodes.length,
    inTree = new Set([0]),
    edges = [];
  while (inTree.size < n) {
    let best = null,
      bd = Infinity;
    for (const u of inTree)
      for (let v = 0; v < n; v++) {
        if (inTree.has(v)) continue;
        const d = dist(nodes[u], nodes[v]);
        if (d < bd) {
          bd = d;
          best = { u, v, d };
        }
      }
    edges.push(best);
    inTree.add(best.v);
  }
  return edges;
}

// 2-OPT
function twoOpt(nodes, order) {
  const n = order.length;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 2; j < n; j++) {
        if (j === n - 1 && i === 0) continue;
        const a = nodes[order[i]],
          b = nodes[order[i + 1]];
        const c = nodes[order[j]],
          d = nodes[order[(j + 1) % n]];
        const before = dist(a, b) + dist(c, d);
        const after = dist(a, c) + dist(b, d);
        if (after < before - 1e-10) {
          order.slice(i + 1, j + 1).reverse();
          improved = true;
        }
      }
    }
  }
  return order;
}

// DFS PREORDER
function dfsPreorder(nodes, edges) {
  const adj = Array.from({ length: nodes.length }, () => []);
  for (const e of edges) {
    adj[e.u].push(e.v);
    adj[e.v].push(e.u);
  }
  const vis = new Set(),
    order = [];
  function dfs(v) {
    vis.add(v);
    order.push(v);
    for (const nb of adj[v]) if (!vis.has(nb)) dfs(nb);
  }
  dfs(0);
  return order;
}

//  BINARY SEARCH SPLIT (Method A)
function binarySearchSplit(nodes, tour, K) {
  if (K === 1) return [tour];

  function greedySplit(X) {
    const segs = [];
    let seg = [0],
      cur = 0,
      curDist = 0;

    for (let i = 1; i < tour.length; i++) {
      const nxt = tour[i];
      const stepDist = dist(nodes[cur], nodes[nxt]);
      const retDist = dist(nodes[nxt], nodes[0]); // cost to return home FROM nxt

      if (curDist + stepDist + retDist <= X + 1e-10 || seg.length === 1) {
        // Can add this stop and still return within budget
        seg.push(nxt);
        curDist += stepDist;
        cur = nxt;
      } else {
        // Close out current drone, start new one
        segs.push(seg);
        seg = [0, nxt];
        curDist = dist(nodes[0], nodes[nxt]);
        cur = nxt;
      }
    }
    segs.push(seg);
    return segs;
  }

  // Find bounds for binary search
  const nodes2 = nodes;
  // Lower bound: longest single-stop cost (depot->stop->depot)
  let lo = 0;
  for (let i = 1; i < tour.length; i++) {
    const c = dist(nodes[0], nodes[tour[i]]) * 2;
    if (c > lo) lo = c;
  }
  // Upper bound: full tour cost
  let hi = 0;
  for (let i = 0; i < tour.length - 1; i++)
    hi += dist(nodes[tour[i]], nodes[tour[i + 1]]);
  hi += dist(nodes[tour[tour.length - 1]], nodes[tour[0]]);

  // Binary search
  for (let iter = 0; iter < 60; iter++) {
    const mid = (lo + hi) / 2;
    const segs = greedySplit(mid);
    if (segs.length <= K) hi = mid;
    else lo = mid;
  }

  return greedySplit(hi);
}

// UNCROSS (Method A)
function findCrossings(nodes, seg) {
  const n = seg.length;
  let improved = true;

  while (improved) {
    improved = false;

    // Check depot→first edge (seg[0]→seg[1]) against all interior edges
    if (n > 2) {
      const depotEdge = [nodes[seg[0]], nodes[seg[1]]];
      for (let j = 2; j < n - 1; j++) {
        const interiorEdge = [nodes[seg[j]], nodes[seg[j + 1]]];
        if (
          segmentsIntersect(
            depotEdge[0],
            depotEdge[1],
            interiorEdge[0],
            interiorEdge[1],
          )
        ) {
          let l = 1,
            r = j;
          while (l < r) {
            [seg[l], seg[r]] = [seg[r], seg[l]];
            l++;
            r--;
          }
          improved = true;
          break;
        }
      }
    }

    // Check last→depot edge (seg[n-1]→seg[0]) against all interior edges
    if (!improved && n > 2) {
      const returnEdge = [nodes[seg[n - 1]], nodes[seg[0]]];
      for (let i = 1; i < n - 2; i++) {
        const interiorEdge = [nodes[seg[i]], nodes[seg[i + 1]]];
        if (
          segmentsIntersect(
            returnEdge[0],
            returnEdge[1],
            interiorEdge[0],
            interiorEdge[1],
          )
        ) {
          let l = i + 1,
            r = n - 1;
          while (l < r) {
            [seg[l], seg[r]] = [seg[r], seg[l]];
            l++;
            r--;
          }
          improved = true;
          break;
        }
      }
    }
  }

  return seg;
}

// function findCrossings(nodes, seg) {
//   const n = seg.length;
//   for (let i = 0; i < n - 1; i++) {
//     for (let j = i + 2; j < n; j++) {
//       const a = nodes[seg[i]],
//         b = nodes[seg[i + 1]];
//       const c = nodes[seg[j]],
//         d = nodes[seg[(j + 1) % n]];
//       if (segmentsIntersect(a, b, c, d)) {
//         let l = i + 1,
//           r = j;
//         while (l < r) {
//           [seg[l], seg[r]] = [seg[r], seg[l]];
//           l++;
//           r--;
//         }
//       }
//     }
//   }
//   return seg;
// }

function segmentsIntersect(a, b, c, d) {
  const ccw = (P, Q, R) =>
    (R.y - P.y) * (Q.x - P.x) > (Q.y - P.y) * (R.x - P.x);
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

//  BALANCED K-CUT (Method B)
function getComponents(nodes, edges, cutSet) {
  const adj = Array.from({ length: nodes.length }, () => []);
  edges.forEach((e, i) => {
    if (cutSet.has(i)) return;
    adj[e.u].push(e.v);
    adj[e.v].push(e.u);
  });
  const vis = new Array(nodes.length).fill(false),
    comps = [];
  for (let s = 0; s < nodes.length; s++) {
    if (vis[s]) continue;
    const comp = [],
      stk = [s];
    while (stk.length) {
      const v = stk.pop();
      if (vis[v]) continue;
      vis[v] = true;
      comp.push(v);
      for (const nb of adj[v]) if (!vis[nb]) stk.push(nb);
    }
    comps.push(comp);
  }
  return comps;
}

function balancedKCut(nodes, edges, K) {
  if (K <= 1) return new Set();
  const cutSet = new Set();

  for (let iter = 0; iter < K - 1; iter++) {
    const comps = getComponents(nodes, edges, cutSet);

    // CRITICAL: Filter out depot-only components
    // They shouldn't exist, but if they do, merge them with largest delivery component
    const validComps = comps.filter((c) => c.filter((v) => v !== 0).length > 0);

    if (validComps.length === 0) break; // No more valid components to cut

    // Find component with most delivery nodes
    let target = null,
      maxD = 0;
    for (const comp of validComps) {
      const deliveries = comp.filter((v) => v !== 0).length;
      if (deliveries > maxD) {
        maxD = deliveries;
        target = comp;
      }
    }

    if (!target || maxD <= 1) break;

    // Find longest edge within this component
    const cs = new Set(target);
    let bestIdx = null,
      bestD = -Infinity;
    edges.forEach((e, i) => {
      if (cutSet.has(i)) return;
      if (cs.has(e.u) && cs.has(e.v) && e.d > bestD) {
        bestD = e.d;
        bestIdx = i;
      }
    });

    if (bestIdx === null) break;

    // Verify the cut doesn't create a depot-only component
    const testCut = new Set(cutSet);
    testCut.add(bestIdx);
    const testComps = getComponents(nodes, edges, testCut);

    // Check: no component with ONLY the depot (no delivery nodes, no access to any)
    const hasBadComp = testComps.some((c) => {
      const dels = c.filter((v) => v !== 0).length;
      return dels === 0; // Depot-only or empty
    });

    if (!hasBadComp) {
      cutSet.add(bestIdx);
      continue;
    }

    // Try next best edges
    let found = false;
    const candidates = edges
      .map((e, i) => ({ e, i }))
      .filter(
        ({ e, i }) =>
          !cutSet.has(i) && cs.has(e.u) && cs.has(e.v) && i !== bestIdx,
      )
      .sort((a, b) => b.e.d - a.e.d);

    for (const { i } of candidates) {
      const tc2 = new Set(cutSet);
      tc2.add(i);
      const c2 = getComponents(nodes, edges, tc2);
      const bad2 = c2.some((c) => c.filter((v) => v !== 0).length === 0);
      if (!bad2) {
        cutSet.add(i);
        found = true;
        break;
      }
    }

    if (!found) break;
  }
  return cutSet;
}

//  NN TOUR (Method B, per subtree)
function nnTour(nodes, subset) {
  const deliveries = subset.filter((v) => v !== 0);
  if (!deliveries.length) return [0];
  const unvis = new Set(deliveries);
  const order = [0];
  let cur = 0;
  while (unvis.size) {
    let nearest = null,
      nd = Infinity;
    for (const v of unvis) {
      const d = dist(nodes[cur], nodes[v]);
      if (d < nd) {
        nd = d;
        nearest = v;
      }
    }
    unvis.delete(nearest);
    order.push(nearest);
    cur = nearest;
  }
  return order;
}

// OR-OPT (Method B, per subtree) — O(m²)
function orOpt(nodes, order) {
  // order is [0, s1, ..., sm] — depot at front
  // Try relocating each delivery node to every other position
  const o = [...order];
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < o.length; i++) {
      const node = o[i];
      const prev = o[i - 1],
        next = o[i + 1] || o[0]; // wrap to depot
      // Cost of removing node i
      const removeCost =
        dist(nodes[prev], nodes[node]) +
        dist(nodes[node], nodes[next]) -
        dist(nodes[prev], nodes[next]);
      // Try inserting between every other consecutive pair
      let bestGain = -1e-10,
        bestJ = -1;
      for (let j = 1; j < o.length; j++) {
        if (j === i || j === i - 1) continue;
        const a = o[j],
          b = o[j + 1] || o[0];
        if (a === node || b === node) continue;
        const insertCost =
          dist(nodes[a], nodes[node]) +
          dist(nodes[node], nodes[b]) -
          dist(nodes[a], nodes[b]);
        const gain = removeCost - insertCost;
        if (gain > bestGain) {
          bestGain = gain;
          bestJ = j;
        }
      }
      if (bestJ >= 0) {
        o.splice(i, 1);
        const insertAt = bestJ > i ? bestJ : bestJ + 1;
        o.splice(insertAt, 0, node);
        improved = true;
        break;
      }
    }
  }
  return o;
}

function tourDist(nodes, order) {
  if (order.length < 2) return 0;
  let d = 0;
  for (let i = 0; i < order.length - 1; i++)
    d += dist(nodes[order[i]], nodes[order[i + 1]]);
  d += dist(nodes[order[order.length - 1]], nodes[order[0]]);
  return d;
}

// DRAWING
function redraw(state = {}) {
  const {
    mst = [],
    showDouble = false,
    eulerEdges = [],
    subtours = [], // [{order,color}]
    cutEdges = [], // edge indices that are cut
    flashEdge = null, // {u,v} to flash bright
    highlightNodes = [], // node indices to highlight
  } = state;

  const nodes = allNodes();
  mctx.clearRect(0, 0, map.width, map.height);

  // MST edges
  for (const e of mst) {
    const isCut = cutEdges.includes(mst.indexOf(e));
    drawLine(
      nodes[e.u],
      nodes[e.v],
      isCut ? "rgba(255,68,102,0.4)" : "rgba(68,136,255,0.2)",
      isCut ? 2 : 1.5,
      isCut ? [5, 4] : [],
    );
  }

  // Doubled edges (phase 1B)
  if (showDouble) {
    for (const e of mst) {
      const a = nodes[e.u],
        b = nodes[e.v];
      const dx = b.x - a.x,
        dy = b.y - a.y,
        len = Math.hypot(dx, dy);
      const nx = (-dy / len) * 3,
        ny = (dx / len) * 3;
      mctx.save();
      mctx.globalAlpha = 0.35;
      mctx.beginPath();
      mctx.moveTo(a.x + nx, a.y + ny);
      mctx.lineTo(b.x + nx, b.y + ny);
      mctx.strokeStyle = "#cc44ff";
      mctx.lineWidth = 1.5;
      mctx.setLineDash([3, 4]);
      mctx.stroke();
      mctx.restore();
    }
  }

  // Euler walk edges
  for (const [u, v] of eulerEdges) {
    drawLine(nodes[u], nodes[v], "rgba(245,166,35,0.5)", 1.5, [3, 4]);
  }

  // Flash edge
  if (flashEdge) {
    drawLine(nodes[flashEdge.u], nodes[flashEdge.v], "#4488ff", 3, []);
  }

  // Sub-tours (arrows)
  for (const { order, color } of subtours) {
    if (order.length < 2) continue;
    const full = [...order, order[0]];
    for (let i = 0; i < full.length - 1; i++) {
      drawArrow(nodes[full[i]], nodes[full[i + 1]], color, 2, 0.9);
    }
  }

  // Highlight nodes
  for (const ni of highlightNodes) {
    const p = nodes[ni];
    mctx.save();
    mctx.beginPath();
    mctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
    mctx.strokeStyle = algo === "A" ? "#f5a623" : "#3dff9a";
    mctx.lineWidth = 1.5;
    mctx.globalAlpha = 0.5;
    mctx.stroke();
    mctx.restore();
  }

  // Delivery points
  const ownedBy = new Array(nodes.length).fill(null);
  for (const { order, color } of subtours)
    for (const v of order) ownedBy[v] = color;

  for (let i = 1; i < nodes.length; i++) {
    const p = nodes[i],
      color = ownedBy[i] || "#4488ff";
    drawDot(p, color, 7, `${i}`);
  }

  // Depot
  if (depot) drawDepot(depot);
}

function drawLine(a, b, color, width, dash = []) {
  mctx.save();
  mctx.beginPath();
  mctx.moveTo(a.x, a.y);
  mctx.lineTo(b.x, b.y);
  mctx.strokeStyle = color;
  mctx.lineWidth = width;
  mctx.setLineDash(dash);
  mctx.stroke();
  mctx.restore();
}

function drawArrow(a, b, color, width, alpha = 1) {
  mctx.save();
  mctx.globalAlpha = alpha;
  const dx = b.x - a.x,
    dy = b.y - a.y,
    len = Math.hypot(dx, dy);
  if (len < 1) {
    mctx.restore();
    return;
  }
  const ux = dx / len,
    uy = dy / len;
  mctx.beginPath();
  mctx.moveTo(a.x, a.y);
  mctx.lineTo(b.x - ux * 9, b.y - uy * 9);
  mctx.strokeStyle = color;
  mctx.lineWidth = width;
  mctx.setLineDash([]);
  mctx.stroke();
  mctx.beginPath();
  mctx.moveTo(b.x - ux * 9, b.y - uy * 9);
  mctx.lineTo(b.x - ux * 16 + uy * 5, b.y - uy * 16 - ux * 5);
  mctx.lineTo(b.x - ux * 16 - uy * 5, b.y - uy * 16 + ux * 5);
  mctx.closePath();
  mctx.fillStyle = color;
  mctx.fill();
  mctx.restore();
}

function drawDot(p, color, r, label) {
  mctx.save();
  mctx.beginPath();
  mctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  mctx.fillStyle = color;
  mctx.fill();
  mctx.strokeStyle = "rgba(0,0,0,0.4)";
  mctx.lineWidth = 1;
  mctx.stroke();
  if (label) {
    mctx.fillStyle = "rgba(255,255,255,0.4)";
    mctx.font = "9px JetBrains Mono,monospace";
    mctx.textAlign = "center";
    mctx.textBaseline = "middle";
    mctx.fillText(label, p.x, p.y - 15);
  }
  mctx.restore();
}

function drawDepot(p) {
  mctx.save();
  mctx.beginPath();
  mctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
  mctx.strokeStyle = "#f5a623";
  mctx.lineWidth = 1.5;
  mctx.stroke();
  mctx.beginPath();
  mctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
  mctx.fillStyle = "#f5a623";
  mctx.fill();
  mctx.fillStyle = "#08080e";
  mctx.font = "bold 8px JetBrains Mono,monospace";
  mctx.textAlign = "center";
  mctx.textBaseline = "middle";
  mctx.fillText("D", p.x, p.y);
  mctx.restore();
}

// PARETO CHART
function recordPareto(k, makespan) {
  const ex = paretoData.find((p) => p.k === k && p.algo === algo);
  if (ex) {
    if (makespan < ex.makespan) ex.makespan = makespan;
  } else paretoData.push({ k, makespan, algo });
  paretoData.sort((a, b) => a.k - b.k || a.algo.localeCompare(b.algo));
  drawPareto();
}

function drawPareto() {
  const W = pcan.width,
    H = pcan.height;
  pctx.clearRect(0, 0, W, H);

  // bg
  pctx.fillStyle = "#0f0f18";
  pctx.beginPath();
  pctx.roundRect(0, 0, W, H, 6);
  pctx.fill();

  if (!paretoData.length) {
    pctx.fillStyle = "#5a5a72";
    pctx.font = "11px JetBrains Mono,monospace";
    pctx.textAlign = "center";
    pctx.textBaseline = "middle";
    pctx.fillText("no data yet", W / 2, H / 2);
    return;
  }

  const pad = { l: 48, r: 20, t: 20, b: 40 };
  const iw = W - pad.l - pad.r,
    ih = H - pad.t - pad.b;

  const kVals = paretoData.map((p) => p.k);
  const msVals = paretoData.map((p) => p.makespan);
  const minK = 1,
    maxK = Math.max(...kVals, 2);
  const minMs = 0,
    maxMs = Math.max(...msVals) * 1.15;

  const px = (k) => pad.l + ((k - minK) / (maxK - minK || 1)) * iw;
  const py = (ms) => pad.t + ih - ((ms - minMs) / (maxMs - minMs || 1)) * ih;

  // grid
  pctx.strokeStyle = "rgba(255,255,255,0.04)";
  pctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ih / 4) * i;
    pctx.beginPath();
    pctx.moveTo(pad.l, y);
    pctx.lineTo(pad.l + iw, y);
    pctx.stroke();
    const val = Math.round(maxMs - (maxMs / 4) * i);
    pctx.fillStyle = "#ffffff";
    pctx.font = "9px JetBrains Mono,monospace";
    pctx.color = "#5a5a72";
    pctx.textAlign = "right";
    pctx.textBaseline = "middle";
    pctx.fillText(val, pad.l - 5, y);
  }
  // x labels
  pctx.textAlign = "center";
  pctx.fillStyle = "#ffffff";
  pctx.font = "9px JetBrains Mono,monospace";
  for (let k = minK; k <= maxK; k++) {
    pctx.fillText(`K=${k}`, px(k), pad.t + ih + 16);
  }
  // axis labels
  pctx.fillStyle = "#ffffff";
  pctx.font = "9px JetBrains Mono,monospace";
  pctx.textAlign = "center";
  pctx.fillText("drones (K)", pad.l + iw / 2, H - 4);
  pctx.save();
  pctx.translate(12, pad.t + ih / 2);
  pctx.rotate(-Math.PI / 2);
  pctx.fillText("makespan", 0, 0);
  pctx.restore();

  // draw lines per algo
  ["A", "B"].forEach((a) => {
    const pts = paretoData
      .filter((p) => p.algo === a)
      .sort((x, y) => x.k - y.k);
    if (pts.length < 2) return;
    const color = a === "A" ? "rgba(68,136,255,0.35)" : "rgba(61,255,154,0.35)";
    pctx.beginPath();
    pctx.moveTo(px(pts[0].k), py(pts[0].makespan));
    for (let i = 1; i < pts.length; i++)
      pctx.lineTo(px(pts[i].k), py(pts[i].makespan));
    pctx.strokeStyle = color;
    pctx.lineWidth = 1.5;
    pctx.setLineDash([4, 4]);
    pctx.stroke();
    pctx.setLineDash([]);
  });

  // dots
  for (const p of paretoData) {
    const x = px(p.k),
      y = py(p.makespan);
    const color = p.algo === "A" ? "#4488ff" : "#3dff9a";
    pctx.beginPath();
    pctx.arc(x, y, 6, 0, Math.PI * 2);
    pctx.fillStyle = color + "30";
    pctx.fill();
    pctx.beginPath();
    pctx.arc(x, y, 3.5, 0, Math.PI * 2);
    pctx.fillStyle = color;
    pctx.fill();
    pctx.fillStyle = color;
    pctx.font = "9px JetBrains Mono,monospace";
    pctx.textAlign = "center";
    pctx.fillText(Math.round(p.makespan), x, y - 12);
  }
}

function updateDroneList(subtours, nodes) {
  const el = document.getElementById("dronelist");
  el.innerHTML = subtours
    .map((s, i) => {
      const stops = s.order.filter((v) => v !== 0).length;
      const d = Math.round(tourDist(nodes, s.order));
      return `<div class="ritem">
      <span class="rswatch" style="background:${s.color}"></span>
      <span class="rname">R${i + 1}</span>
      <span class="rstops">${stops} stops</span>
      <span class="rdist">${d}u</span>
    </div>`;
    })
    .join("");
}

// MAIN SOLVE
async function runSolve() {
  if (animating || !depot || pts.length < 2) return;
  animating = true;
  paused = false;
  document.getElementById("btnRun").disabled = true;
  resetPhases();
  document.getElementById("dronelist").innerHTML = "";
  document.getElementById("sv-makespan").textContent = "—";
  document.getElementById("sv-total").textContent = "—";

  if (algo === "A") await solveA();
  else await solveB();

  animating = false;
  document.getElementById("btnRun").disabled = false;
}

// ═══════════════════════════════════════════════════════════
//  METHOD A: MST → DFS → 2-opt → binary split → uncross
// ═══════════════════════════════════════════════════════════
async function solveA() {
  const nodes = allNodes();

  // ── Phase 0: MST ─────────────────────────────────────────
  setPhase(0, "active");
  setStatus("building MST…", "running");

  let mst = frozenMST;
  if (!mst) {
    mst = [];
    const inTree = new Set([0]);
    redraw({ mst });
    await wait();
    while (inTree.size < nodes.length) {
      let best = null,
        bd = Infinity;
      for (const u of inTree)
        for (let v = 0; v < nodes.length; v++) {
          if (inTree.has(v)) continue;
          const d = dist(nodes[u], nodes[v]);
          if (d < bd) {
            bd = d;
            best = { u, v, d };
          }
        }
      mst.push(best);
      inTree.add(best.v);
      redraw({ mst, flashEdge: { u: best.u, v: best.v } });
      await wait();
    }
    frozenMST = mst;
  } else {
    // already frozen, just show it
    redraw({ mst });
    await wait(300);
    setStatus("MST loaded from cache", "running");
  }
  setPhase(0, "done");
  await sleep(150);

  // ── Phase 1: DFS ─────────────────────────────────────────
  setPhase(1, "active");
  setStatus("DFS preorder walk…", "running");

  let tour = frozenTour;
  if (!tour) {
    const walk = dfsPreorder(nodes, mst);
    // Animate the walk
    const eulerEdges = [];
    for (let i = 0; i < walk.length - 1; i++) {
      eulerEdges.push([walk[i], walk[i + 1]]);
      redraw({
        mst,
        eulerEdges: [...eulerEdges],
        highlightNodes: [walk[i + 1]],
      });
      await wait();
    }
    tour = [...new Set(walk)];
    setPhase(1, "done");
    await sleep(150);

    // ── Phase 2: 2-opt ───────────────────────────────────────
    setPhase(2, "active");
    setStatus("2-opt convergence…", "running");

    // Animated 2-opt: show each improvement
    const n = tour.length;
    let improved = true,
      pass = 0;
    while (improved) {
      improved = false;
      pass++;
      for (let i = 0; i < n - 1; i++) {
        for (let j = i + 2; j < n; j++) {
          if (j === n - 1 && i === 0) continue;
          const a = nodes[tour[i]],
            b = nodes[tour[i + 1]];
          const c = nodes[tour[j]],
            d = nodes[tour[(j + 1) % n]];
          if (dist(a, c) + dist(b, d) < dist(a, b) + dist(c, d) - 1e-10) {
            let l = i + 1,
              r = j;
            while (l < r) {
              [tour[l], tour[r]] = [tour[r], tour[l]];
              l++;
              r--;
            }
            improved = true;
            redraw({
              mst,
              subtours: [{ order: tour, color: "#4488ff" }],
            });
            await wait();
          }
        }
      }
      setStatus(`2-opt pass ${pass}…`, "running");
    }
    frozenTour = [...tour];
    setPhase(2, "done");
    await sleep(150);
  } else {
    setPhase(1, "done");
    setPhase(2, "done");
    setStatus("tour loaded from cache — skipping 2-opt", "running");
    redraw({ mst, subtours: [{ order: tour, color: "#4488ff" }] });
    await wait(400);
  }

  // ── Phase 3: Binary search ───────────────────────────────
  setPhase(3, "active");
  setStatus("binary search for min makespan X…", "running");
  redraw({
    mst,
    subtours: [{ order: tour, color: "rgba(68,136,255,0.3)" }],
  });
  await wait(300);

  const segs = binarySearchSplit(nodes, tour, K);
  setPhase(3, "done");
  await sleep(150);

  // ── Phase 4: Greedy assignment (animate) ─────────────────
  setPhase(4, "active");
  setStatus("assigning drones greedily…", "running");

  const subtours = [];
  for (let i = 0; i < segs.length; i++) {
    const color = RC[i % RC.length];
    subtours.push({ order: segs[i], color });
    redraw({ mst, subtours: [...subtours] });
    await wait();
  }
  setPhase(4, "done");
  await sleep(150);

  // ── Phase 5: uncross ───────────────────────────
  setPhase(5, "active");
  setStatus("uncrossing segments…", "running");

  for (let si = 0; si < subtours.length; si++) {
    const { order, color } = subtours[si];
    if (order.length < 4) continue;
    const seg = [...order];
    // Find and animate each crossing fix
    let improved2 = true;
    while (improved2) {
      improved2 = false;
      outer: for (let i = 0; i < seg.length - 1; i++) {
        for (let j = i + 2; j < seg.length; j++) {
          if (j === seg.length - 1 && i === 0) continue;
          const jn = (j + 1) % seg.length;
          const a = nodes[seg[i]],
            b = nodes[seg[i + 1]];
          const c = nodes[seg[j]],
            d = nodes[seg[jn]];
          if (segmentsIntersect(a, b, c, d)) {
            // Animate the crossing
            mctx.save();
            mctx.beginPath();
            mctx.moveTo(a.x, a.y);
            mctx.lineTo(b.x, b.y);
            mctx.strokeStyle = "#ff4466";
            mctx.lineWidth = 2.5;
            mctx.stroke();
            mctx.beginPath();
            mctx.moveTo(c.x, c.y);
            mctx.lineTo(d.x, d.y);
            mctx.strokeStyle = "#ff4466";
            mctx.lineWidth = 2.5;
            mctx.stroke();
            mctx.restore();
            await wait();

            // Fix the crossing
            let l = i + 1,
              r = j;
            while (l < r) {
              [seg[l], seg[r]] = [seg[r], seg[l]];
              l++;
              r--;
            }
            subtours[si] = { order: [...seg], color };
            redraw({ mst, subtours: [...subtours] });
            await wait();
            improved2 = true;
            break outer;
          }
        }
      }
    }
    subtours[si] = { order: [...seg], color };
  }

  setPhase(5, "done");
  finalize(nodes, subtours, mst);
}

// ═══════════════════════════════════════════════════════════
//  METHOD B: MST → balanced K-cut → NN → Or-opt
// ═══════════════════════════════════════════════════════════
async function solveB() {
  const nodes = allNodes();

  // ── Phase 0: MST ─────────────────────────────────────────
  setPhase(0, "active");
  setStatus("building MST…", "running");

  let mst = frozenMST;
  if (!mst) {
    mst = [];
    const inTree = new Set([0]);
    redraw({ mst });
    await wait();
    while (inTree.size < nodes.length) {
      let best = null,
        bd = Infinity;
      for (const u of inTree)
        for (let v = 0; v < nodes.length; v++) {
          if (inTree.has(v)) continue;
          const d = dist(nodes[u], nodes[v]);
          if (d < bd) {
            bd = d;
            best = { u, v, d };
          }
        }
      mst.push(best);
      inTree.add(best.v);
      redraw({ mst, flashEdge: { u: best.u, v: best.v } });
      await wait();
    }
    frozenMST = mst;
  } else {
    redraw({ mst });
    await wait(300);
    setStatus("MST loaded from cache", "running");
  }
  setPhase(0, "done");
  await sleep(150);

  // ── Phase 1: Balanced K-cut ───────────────────────────────
  setPhase(1, "active");
  setStatus("balanced recursive K-cut…", "running");
  redraw({ mst });
  await wait(200);

  const cutSet = balancedKCut(nodes, mst, K);

  // Animate showing cut edges
  const cutIndices = [...cutSet];
  for (const ci of cutIndices) {
    const e = mst[ci];
    mctx.save();
    mctx.beginPath();
    mctx.moveTo(nodes[e.u].x, nodes[e.u].y);
    mctx.lineTo(nodes[e.v].x, nodes[e.v].y);
    mctx.strokeStyle = "#ff4466";
    mctx.lineWidth = 3;
    mctx.stroke();
    // draw X
    const mx = (nodes[e.u].x + nodes[e.v].x) / 2,
      my = (nodes[e.u].y + nodes[e.v].y) / 2;
    mctx.strokeStyle = "#ff4466";
    mctx.lineWidth = 2;
    mctx.beginPath();
    mctx.moveTo(mx - 5, my - 5);
    mctx.lineTo(mx + 5, my + 5);
    mctx.stroke();
    mctx.beginPath();
    mctx.moveTo(mx + 5, my - 5);
    mctx.lineTo(mx - 5, my + 5);
    mctx.stroke();
    mctx.restore();
    await wait();
  }

  const comps = getComponents(nodes, mst, cutSet);
  setPhase(1, "done");
  await sleep(150);

  // ── Phase 2: NN per subtree ───────────────────────────────
  setPhase(2, "active");
  setStatus("nearest-neighbor tour per subtree…", "running");

  const subtours = [];
  for (let ci = 0; ci < comps.length; ci++) {
    const comp = comps[ci];
    const color = RC[ci % RC.length];
    const subset = comp.includes(0) ? comp : [0, ...comp];

    // Animate NN building
    const deliveries = subset.filter((v) => v !== 0);
    const unvis = new Set(deliveries);
    const order = [0];
    let cur = 0;
    while (unvis.size) {
      let nearest = null,
        nd = Infinity;
      for (const v of unvis) {
        const d = dist(nodes[cur], nodes[v]);
        if (d < nd) {
          nd = d;
          nearest = v;
        }
      }
      unvis.delete(nearest);
      order.push(nearest);
      cur = nearest;
      subtours[ci] = { order: [...order], color };
      redraw({ mst, subtours: [...subtours], cutEdges: cutIndices });
      await wait();
    }
    subtours[ci] = { order: [...order], color };
  }
  setPhase(2, "done");
  await sleep(150);

  // ── Phase 3: Or-opt per subtree ───────────────────────────
  setPhase(3, "active");
  setStatus("Or-opt local polish…", "running");

  for (let ci = 0; ci < subtours.length; ci++) {
    const { order, color } = subtours[ci];
    if (order.length < 4) continue;
    const improved = orOpt(nodes, order);
    if (improved.join() !== order.join()) {
      subtours[ci] = { order: improved, color };
      redraw({ mst, subtours: [...subtours], cutEdges: cutIndices });
      await wait();
    }
  }

  setPhase(3, "done");
  finalize(nodes, subtours, mst, [...cutIndices]);
}

// ═══════════════════════════════════════════════════════════
//  FINALIZE
// ═══════════════════════════════════════════════════════════
function finalize(nodes, subtours, mst, cutEdges = []) {
  const dists = subtours.map((s) => tourDist(nodes, s.order));
  const makespan = Math.max(...dists);
  const total = dists.reduce((a, b) => a + b, 0);

  document.getElementById("sv-makespan").textContent = Math.round(makespan);
  document.getElementById("sv-total").textContent = Math.round(total);

  updateDroneList(subtours, nodes);
  recordPareto(K, makespan);

  redraw({ mst, subtours, cutEdges });
  setStatus(
    `done · ${subtours.length} drone${subtours.length !== 1 ? "s" : ""} · makespan ${Math.round(makespan)} · product ${subtours.length * Math.round(makespan)}`,
    "done",
  );
}

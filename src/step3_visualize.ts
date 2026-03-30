import { mkdir, readFile, writeFile } from "node:fs/promises";

type Graph = {
  nodes: { id: string; label: string; toolkit: string }[];
  edges: { from: string; to: string; label: string; reason: string }[];
};

function escapeDotLabel(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function parseArgs(argv: string[]): {
  inPath: string;
  outDir: string;
  maxEdges: number;
  maxNodes: number;
} {
  let inPath = "artifacts/dependency_graph.json";
  let outDir = "artifacts";
  let maxEdges = 1500;
  let maxNodes = 500;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") {
      const v = argv[i + 1];
      if (v) {
        inPath = v;
        i++;
      }
      continue;
    }
    if (a === "--out") {
      const v = argv[i + 1];
      if (v) {
        outDir = v;
        i++;
      }
      continue;
    }
    if (a === "--max-edges") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v)) {
        maxEdges = v;
        i++;
      }
      continue;
    }
    if (a === "--max-nodes") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v)) {
        maxNodes = v;
        i++;
      }
      continue;
    }
  }
  return { inPath, outDir, maxEdges, maxNodes };
}

function pickSubgraph(graph: Graph, maxNodes: number, maxEdges: number): Graph {
  // Keep all nodes, but we'll downsample edges and induced nodes for readability.
  // Prefer explicit_reference edges first, then a slice of the rest.
  const explicit = graph.edges.filter((e) => e.reason === "explicit_reference");
  const other = graph.edges.filter((e) => e.reason !== "explicit_reference");

  const pickedEdges = [
    ...explicit,
    ...other.slice(0, Math.max(0, maxEdges - explicit.length)),
  ].slice(0, maxEdges);

  const used = new Set<string>();
  for (const e of pickedEdges) {
    used.add(e.from);
    used.add(e.to);
  }

  // If still too many nodes, cap by keeping nodes that appear in edges first.
  const usedList = Array.from(used);
  const keepIds = new Set<string>(usedList.slice(0, maxNodes));
  const nodes = graph.nodes.filter((n) => keepIds.has(n.id));
  const edges = pickedEdges.filter((e) => keepIds.has(e.from) && keepIds.has(e.to));

  return { nodes, edges };
}

function toDot(graph: Graph): string {
  const toolkitColors: Record<string, string> = {
    googlesuper: "#1a73e8",
    github: "#24292e",
    unknown: "#666666",
  };

  const lines: string[] = [];
  lines.push("digraph ToolDeps {");
  lines.push('  graph [bgcolor="white", rankdir="LR", splines=true, overlap=false];');
  lines.push('  node [shape="box", style="rounded,filled", fontname="Helvetica", fontsize=10, fillcolor="#f7f7f7", color="#dddddd"];');
  lines.push('  edge [color="#999999", fontname="Helvetica", fontsize=9];');

  for (const n of graph.nodes) {
    const color = toolkitColors[n.toolkit] ?? toolkitColors.unknown;
    const label = `${n.label}\\n${n.id}`;
    lines.push(
      `  "${escapeDotLabel(n.id)}" [label="${escapeDotLabel(label)}", fillcolor="${color}22", color="${color}"];`
    );
  }

  for (const e of graph.edges) {
    const edgeColor = e.reason === "explicit_reference" ? "#d73a49" : "#6a737d";
    lines.push(
      `  "${escapeDotLabel(e.from)}" -> "${escapeDotLabel(e.to)}" [label="${escapeDotLabel(
        e.label
      )}", color="${edgeColor}"];`
    );
  }

  lines.push("}");
  return lines.join("\n");
}

function htmlViewer(graph: Graph): string {
  // Fully self-contained viewer (no CDN). Renders a simple canvas-based graph:
  // - pan/zoom
  // - filter by id/label (substring)
  // - optional lightweight force layout (edge springs + sampled repulsion)
  const data = JSON.stringify(graph);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tool Dependency Graph</title>
    <style>
      :root {
        --bg: #0b0f14;
        --panel: rgba(255,255,255,0.06);
        --text: #e8eef6;
        --muted: rgba(232,238,246,0.7);
        --accent: #7bdff2;
        --danger: #ff5a7a;
      }
      html, body { height: 100%; margin: 0; background: var(--bg); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; }
      #wrap { display: grid; grid-template-columns: 340px 1fr; height: 100%; }
      #panel { padding: 16px; border-right: 1px solid rgba(255,255,255,0.08); background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02)); }
      #panel h1 { font-size: 14px; letter-spacing: 0.08em; text-transform: uppercase; margin: 0 0 10px; color: var(--muted); }
      #panel .stat { padding: 10px 12px; border-radius: 12px; background: var(--panel); margin-bottom: 10px; }
      #panel .stat b { color: var(--accent); }
      #panel label { display: block; font-size: 12px; color: var(--muted); margin: 14px 0 6px; }
      #panel input { width: 100%; padding: 10px 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.2); color: var(--text); outline: none; }
      #panel button { width: 100%; padding: 10px 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06); color: var(--text); cursor: pointer; }
      #panel button:hover { background: rgba(255,255,255,0.09); }
      #panel .hint { font-size: 12px; color: var(--muted); margin-top: 8px; line-height: 1.35; }
      #graph { position: relative; }
      #c { width: 100%; height: 100%; display: block; }
      .pill { display:inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; margin-left: 6px; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.06); color: var(--muted); }
      #toast { position:absolute; left: 12px; bottom: 12px; padding: 10px 12px; border-radius: 12px; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.08); color: rgba(232,238,246,0.85); font-size: 12px; max-width: 560px; pointer-events:none; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <div id="wrap">
      <div id="panel">
        <h1>Tool dependency graph</h1>
        <div class="stat">Nodes: <b id="nNodes">0</b> <span class="pill">tools</span></div>
        <div class="stat">Edges: <b id="nEdges">0</b> <span class="pill">dependencies</span></div>
        <label for="q">Filter (tool name or slug)</label>
        <input id="q" placeholder="e.g. REPLY_TO_THREAD, issue, calendar" />
        <label>Layout</label>
        <button id="layoutBtn" type="button">Run quick layout (10s)</button>
        <div class="hint">
          - Drag to pan, scroll to zoom.<br/>
          - Red edges: explicit references in schema text.<br/>
          - Gray edges: inferred by matching required params to output fields (heuristic).<br/>
        </div>
      </div>
      <div id="graph">
        <canvas id="c"></canvas>
        <div id="toast"></div>
      </div>
    </div>
    <script>
      const graph = ${data};
      const colorByToolkit = { googlesuper: "#1a73e8", github: "#2ea043", unknown: "#6a737d" };
      const EDGE_EXPLICIT = "${"#ff5a7a"}";
      const EDGE_INFERRED = "${"#6a737d"}";

      const canvas = document.getElementById("c");
      const toast = document.getElementById("toast");
      const ctx = canvas.getContext("2d");

      const DPR = Math.max(1, Math.floor(window.devicePixelRatio || 1));
      function resize() {
        const r = canvas.getBoundingClientRect();
        canvas.width = Math.floor(r.width * DPR);
        canvas.height = Math.floor(r.height * DPR);
      }
      window.addEventListener("resize", resize);
      resize();

      // View state
      let panX = 0, panY = 0, zoom = 1;
      let isPanning = false;
      let lastX = 0, lastY = 0;

      // Build indexed data
      const nodesAll = graph.nodes.map((n, i) => ({
        idx: i,
        id: n.id,
        label: n.label,
        toolkit: n.toolkit,
        x: (Math.random() - 0.5) * 2000,
        y: (Math.random() - 0.5) * 2000,
        vx: 0, vy: 0
      }));
      const idxById = new Map(nodesAll.map(n => [n.id, n.idx]));
      const edgesAll = graph.edges
        .map(e => ({ ...e, a: idxById.get(e.from), b: idxById.get(e.to) }))
        .filter(e => typeof e.a === "number" && typeof e.b === "number");

      let visibleNodeIdx = new Set(nodesAll.map(n => n.idx));
      let visibleEdges = edgesAll;

      document.getElementById("nNodes").textContent = String(nodesAll.length);
      document.getElementById("nEdges").textContent = String(edgesAll.length);

      function worldToScreen(x, y) {
        const w = canvas.width, h = canvas.height;
        return {
          sx: (w / 2) + (x * zoom + panX) * DPR,
          sy: (h / 2) + (y * zoom + panY) * DPR
        };
      }
      function screenToWorld(sx, sy) {
        const w = canvas.width, h = canvas.height;
        const x = ((sx - w / 2) / DPR - panX) / zoom;
        const y = ((sy - h / 2) / DPR - panY) / zoom;
        return { x, y };
      }

      function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.scale(DPR, DPR);
        ctx.translate(panX, panY);
        ctx.scale(zoom, zoom);

        // edges
        ctx.lineWidth = 1 / zoom;
        for (const e of visibleEdges) {
          const a = nodesAll[e.a], b = nodesAll[e.b];
          ctx.strokeStyle = (e.reason === "explicit_reference") ? EDGE_EXPLICIT : EDGE_INFERRED;
          ctx.globalAlpha = (e.reason === "explicit_reference") ? 0.85 : 0.35;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // nodes
        const r = 4 / zoom;
        for (const idx of visibleNodeIdx) {
          const n = nodesAll[idx];
          ctx.fillStyle = (colorByToolkit[n.toolkit] || colorByToolkit.unknown);
          ctx.globalAlpha = 0.9;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;

        ctx.restore();
      }

      function findNearestNode(mx, my) {
        const p = screenToWorld(mx, my);
        let best = null;
        let bestD2 = Infinity;
        // sample a subset for performance
        let seen = 0;
        for (const idx of visibleNodeIdx) {
          const n = nodesAll[idx];
          const dx = n.x - p.x, dy = n.y - p.y;
          const d2 = dx*dx + dy*dy;
          if (d2 < bestD2) { bestD2 = d2; best = n; }
          if (++seen > 2500) break;
        }
        return bestD2 < (40/zoom)*(40/zoom) ? best : null;
      }

      canvas.addEventListener("mousedown", (ev) => {
        isPanning = true;
        lastX = ev.clientX; lastY = ev.clientY;
      });
      window.addEventListener("mouseup", () => { isPanning = false; });
      window.addEventListener("mousemove", (ev) => {
        const n = findNearestNode(ev.clientX, ev.clientY);
        if (n) {
          toast.textContent = n.label + "\\n" + n.id + "\\n" + (n.toolkit || "unknown");
        } else {
          toast.textContent = "";
        }
        if (!isPanning) return;
        const dx = ev.clientX - lastX;
        const dy = ev.clientY - lastY;
        lastX = ev.clientX; lastY = ev.clientY;
        panX += dx / zoom;
        panY += dy / zoom;
        draw();
      });
      canvas.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        const delta = Math.sign(ev.deltaY);
        const factor = delta > 0 ? 0.9 : 1.1;
        zoom = Math.min(5, Math.max(0.1, zoom * factor));
        draw();
      }, { passive: false });

      // filtering
      const q = document.getElementById("q");
      function applyFilter() {
        const needle = q.value.trim().toLowerCase();
        if (!needle) {
          visibleNodeIdx = new Set(nodesAll.map(n => n.idx));
          visibleEdges = edgesAll;
          document.getElementById("nNodes").textContent = String(nodesAll.length);
          document.getElementById("nEdges").textContent = String(edgesAll.length);
          draw();
          return;
        }
        const keep = new Set();
        for (const n of nodesAll) {
          if (n.id.toLowerCase().includes(needle) || (n.label || "").toLowerCase().includes(needle)) keep.add(n.idx);
        }
        visibleNodeIdx = keep;
        visibleEdges = edgesAll.filter(e => keep.has(e.a) && keep.has(e.b));
        document.getElementById("nNodes").textContent = String(keep.size);
        document.getElementById("nEdges").textContent = String(visibleEdges.length);
        draw();
      }
      q.addEventListener("input", () => {
        window.clearTimeout(q._t);
        q._t = window.setTimeout(applyFilter, 150);
      });

      // lightweight layout
      async function runLayout(ms=10000) {
        const start = performance.now();
        const kSpring = 0.0025;
        const rest = 60;
        const repulse = 1600;
        const damping = 0.85;

        const active = Array.from(visibleNodeIdx).map(i => nodesAll[i]);
        const activeEdges = visibleEdges.map(e => ({ a: nodesAll[e.a], b: nodesAll[e.b] }));

        while (performance.now() - start < ms) {
          // edge springs
          for (const e of activeEdges) {
            const dx = e.b.x - e.a.x;
            const dy = e.b.y - e.a.y;
            const dist = Math.hypot(dx, dy) || 1;
            const f = kSpring * (dist - rest);
            const fx = (dx / dist) * f;
            const fy = (dy / dist) * f;
            e.a.vx += fx; e.a.vy += fy;
            e.b.vx -= fx; e.b.vy -= fy;
          }
          // sampled repulsion (avoid O(n^2))
          for (let i = 0; i < active.length; i++) {
            const a = active[i];
            for (let s = 0; s < 12; s++) {
              const b = active[(i * 37 + s * 101) % active.length];
              if (a === b) continue;
              const dx = a.x - b.x;
              const dy = a.y - b.y;
              const d2 = dx*dx + dy*dy + 0.01;
              const f = repulse / d2;
              a.vx += dx * f * 0.00002;
              a.vy += dy * f * 0.00002;
            }
          }
          // integrate
          for (const n of active) {
            n.vx *= damping; n.vy *= damping;
            n.x += n.vx; n.y += n.vy;
          }
          draw();
          await new Promise(r => setTimeout(r, 16));
        }
      }

      document.getElementById("layoutBtn").addEventListener("click", () => runLayout(10000));

      // initial draw so you always see *something*
      draw();
    </script>
  </body>
</html>`;
}

async function main() {
  const { inPath, outDir, maxEdges, maxNodes } = parseArgs(process.argv.slice(2));
  const raw = await readFile(inPath, "utf-8");
  const parsed = JSON.parse(raw) as { nodes: Graph["nodes"]; edges: Graph["edges"] };

  const full: Graph = { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] };
  const sub = pickSubgraph(full, maxNodes, maxEdges);

  await mkdir(outDir, { recursive: true });

  await writeFile(`${outDir}/dependency_graph.dot`, toDot(sub), "utf-8");
  await writeFile(`${outDir}/dependency_graph.html`, htmlViewer(sub), "utf-8");

  console.log(
    JSON.stringify(
      {
        inPath,
        outDir,
        full: { nodes: full.nodes.length, edges: full.edges.length },
        visualized: { nodes: sub.nodes.length, edges: sub.edges.length },
        files: ["dependency_graph.dot", "dependency_graph.html"],
        note: "If Graphviz is installed, you can render: dot -Tsvg artifacts/dependency_graph.dot -o artifacts/dependency_graph.svg",
      },
      null,
      2
    )
  );
}

await main();


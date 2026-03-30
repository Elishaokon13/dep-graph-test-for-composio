import { mkdir, readFile, writeFile } from "node:fs/promises";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

type Tool = {
  slug: string;
  name: string;
  description?: string;
  inputParameters?: unknown;
  outputParameters?: unknown;
  toolkit?: { slug?: string; name?: string };
};

type GraphNode = {
  id: string; // tool slug
  label: string; // tool name
  toolkit: string;
};

type GraphEdge = {
  from: string;
  to: string;
  label: string;
  reason: "explicit_reference" | "output_matches_required_param";
  detail?: string;
  param?: string;
};

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function toJsonValue(v: unknown): JsonValue {
  if (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  )
    return v;
  if (Array.isArray(v)) return v.map(toJsonValue);
  const rec = asRecord(v);
  if (!rec) return String(v);
  const out: { [k: string]: JsonValue } = {};
  for (const [k, val] of Object.entries(rec)) out[k] = toJsonValue(val);
  return out;
}

function getToolkitSlug(t: Tool): string {
  const tk = t.toolkit?.slug ?? t.toolkit?.name;
  return typeof tk === "string" && tk.trim() ? tk : "unknown";
}

function extractRequiredParams(inputParameters: unknown): string[] {
  const schema = asRecord(inputParameters);
  if (!schema) return [];
  const required = schema.required;
  if (!Array.isArray(required)) return [];
  return required.filter((x) => typeof x === "string") as string[];
}

function extractParamDescriptions(inputParameters: unknown): Record<string, string> {
  const schema = asRecord(inputParameters);
  const props = schema ? asRecord(schema.properties) : undefined;
  if (!props) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    const rec = asRecord(v);
    const d = rec?.description;
    if (typeof d === "string" && d.trim()) out[k] = d;
  }
  return out;
}

function collectOutputPropertyNames(outputParameters: unknown): Set<string> {
  const names = new Set<string>();
  const seen = new Set<unknown>();

  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    const rec = asRecord(node);
    if (!rec) return;

    const props = asRecord(rec.properties);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        names.add(k);
        walk(v);
      }
    }

    // common schema fields that can nest objects/arrays
    walk(rec.items);
    walk(rec.anyOf);
    walk(rec.oneOf);
    walk(rec.allOf);
    walk(rec.additionalProperties);
  };

  walk(outputParameters);
  return names;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function scoreProducerCandidate(consumer: Tool, producer: Tool, param: string): number {
  let score = 0;

  if (getToolkitSlug(consumer) === getToolkitSlug(producer)) score += 3;

  const producerName = producer.name.toLowerCase();
  if (producerName.includes("list")) score += 2;
  if (producerName.includes("search")) score += 2;
  if (producerName.includes("get ")) score += 1;

  const tokens = tokenize(param.replace(/_id$/i, "").replace(/id$/i, ""));
  for (const tok of tokens) {
    if (tok.length <= 2) continue;
    if (producerName.includes(tok)) score += 2;
    if (producer.slug.toLowerCase().includes(tok)) score += 1;
  }

  return score;
}

function parseArgs(argv: string[]): { inDir: string; outDir: string } {
  let inDir = "artifacts";
  let outDir = "artifacts";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") {
      const v = argv[i + 1];
      if (v) {
        inDir = v;
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
  }
  return { inDir, outDir };
}

async function loadToolsFromFile(path: string): Promise<Tool[]> {
  const raw = await readFile(path, "utf-8");
  const arr = JSON.parse(raw) as unknown;
  if (!Array.isArray(arr)) throw new Error(`Expected array in ${path}`);

  const tools: Tool[] = [];
  for (const item of arr) {
    const rec = asRecord(item);
    if (!rec) continue;
    const slug = rec.slug;
    const name = rec.name;
    if (typeof slug !== "string" || typeof name !== "string") continue;
    tools.push({
      slug,
      name,
      description: typeof rec.description === "string" ? rec.description : undefined,
      inputParameters: rec.inputParameters,
      outputParameters: rec.outputParameters,
      toolkit: asRecord(rec.toolkit) as Tool["toolkit"],
    });
  }
  return tools;
}

async function main() {
  const { inDir, outDir } = parseArgs(process.argv.slice(2));

  const googlePath = `${inDir}/googlesuper_raw_tools.json`;
  const githubPath = `${inDir}/github_raw_tools.json`;

  const tools = [
    ...(await loadToolsFromFile(googlePath)),
    ...(await loadToolsFromFile(githubPath)),
  ];

  const bySlug = new Map<string, Tool>();
  for (const t of tools) bySlug.set(t.slug, t);

  const nodes: GraphNode[] = tools.map((t) => ({
    id: t.slug,
    label: t.name,
    toolkit: getToolkitSlug(t),
  }));

  const allSlugs = new Set<string>(tools.map((t) => t.slug));
  const outputPropsBySlug = new Map<string, Set<string>>();
  for (const t of tools) {
    outputPropsBySlug.set(t.slug, collectOutputPropertyNames(t.outputParameters));
  }

  const edges: GraphEdge[] = [];
  const edgeKey = new Set<string>();
  const addEdge = (e: GraphEdge) => {
    const key = `${e.from}::${e.to}::${e.reason}::${e.param ?? ""}::${e.label}`;
    if (edgeKey.has(key)) return;
    edgeKey.add(key);
    edges.push(e);
  };

  // Heuristic A: explicit references in parameter descriptions (mentions another tool slug)
  for (const consumer of tools) {
    const paramDescriptions = extractParamDescriptions(consumer.inputParameters);
    for (const [param, desc] of Object.entries(paramDescriptions)) {
      // capture ALLCAPS tool slugs and also any slug-like tokens
      const matches = desc.match(/[A-Z0-9_]{8,}/g) ?? [];
      for (const token of matches) {
        let resolvedSlug: string | undefined;
        if (allSlugs.has(token)) resolvedSlug = token;

        // Common aliasing in Google Super docs: GMAIL_FOO_BAR -> GOOGLESUPER_FOO_BAR
        if (!resolvedSlug && token.startsWith("GMAIL_")) {
          const candidate = `GOOGLESUPER_${token.slice("GMAIL_".length)}`;
          if (allSlugs.has(candidate)) resolvedSlug = candidate;
        }

        if (!resolvedSlug) continue;
        if (resolvedSlug === consumer.slug) continue;
        const producer = bySlug.get(resolvedSlug);
        if (!producer) continue;
        addEdge({
          from: producer.slug,
          to: consumer.slug,
          label: `${param}`,
          reason: "explicit_reference",
          param,
          detail:
            resolvedSlug === token
              ? "Param description references producer tool slug."
              : `Param description references "${token}" which was mapped to "${resolvedSlug}".`,
        });
      }
    }
  }

  // Heuristic B: if a tool requires param P, connect from tools whose output schema contains P
  // (then score/filter to keep graph readable)
  for (const consumer of tools) {
    const required = extractRequiredParams(consumer.inputParameters);
    if (!required.length) continue;

    for (const param of required) {
      const candidates: { slug: string; score: number }[] = [];
      for (const producer of tools) {
        if (producer.slug === consumer.slug) continue;
        const outProps = outputPropsBySlug.get(producer.slug);
        if (!outProps || !outProps.has(param)) continue;
        const score = scoreProducerCandidate(consumer, producer, param);
        if (score > 0) candidates.push({ slug: producer.slug, score });
      }

      candidates.sort((a, b) => b.score - a.score);
      const top = candidates.slice(0, 3);
      for (const c of top) {
        addEdge({
          from: c.slug,
          to: consumer.slug,
          label: `${param}`,
          reason: "output_matches_required_param",
          param,
          detail: `Producer output schema contains "${param}". score=${c.score}`,
        });
      }
    }
  }

  await mkdir(outDir, { recursive: true });

  const graph = {
    generatedAt: new Date().toISOString(),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
  };

  await writeFile(
    `${outDir}/dependency_graph.json`,
    JSON.stringify(graph, null, 2),
    "utf-8"
  );

  // small console summary
  const edgesByReason = edges.reduce(
    (acc, e) => {
      acc[e.reason] = (acc[e.reason] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );
  console.log(
    JSON.stringify(
      {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        edgesByReason,
        sampleEdges: edges.slice(0, 10).map((e) => ({
          from: e.from,
          to: e.to,
          label: e.label,
          reason: e.reason,
        })),
      },
      null,
      2
    )
  );
  console.log(`Wrote ${outDir}/dependency_graph.json`);
}

await main();


import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Composio } from "@composio/core";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

type RawTool = {
  name?: unknown;
  description?: unknown;
  input_parameters?: unknown; // older/alt casing
  inputParameters?: unknown; // observed casing
  parameters?: unknown; // older/alt naming
  outputParameters?: unknown;
  // Composio may include other fields; we keep them via "as unknown"
  [k: string]: unknown;
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

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

function extractJsonSchema(tool: RawTool): Record<string, unknown> | undefined {
  const ipCamel = asRecord(tool.inputParameters);
  if (ipCamel) return ipCamel;
  const ip = asRecord(tool.input_parameters);
  if (ip) return ip;
  const p = asRecord(tool.parameters);
  if (p) return p;
  return undefined;
}

function extractRequiredFromSchema(
  schema: Record<string, unknown> | undefined
): string[] | "unknown" {
  if (!schema) return "unknown";
  const required = (schema as { required?: unknown }).required;
  if (!Array.isArray(required)) return "unknown";
  const strings = required.filter((x) => typeof x === "string") as string[];
  return strings.length > 0 ? strings : [];
}

function extractPropertiesFromSchema(
  schema: Record<string, unknown> | undefined
): string[] | "unknown" {
  if (!schema) return "unknown";
  const props = (schema as { properties?: unknown }).properties;
  const propsRec = asRecord(props);
  if (!propsRec) return "unknown";
  return Object.keys(propsRec).sort();
}

type NormalizedTool = {
  toolkit: string;
  name: string;
  description?: string;
  requiredParams: string[] | "unknown";
  paramKeys: string[] | "unknown";
  raw: JsonValue;
};

function normalizeTool(toolkit: string, t: RawTool): NormalizedTool | null {
  const name = asString(t.name);
  if (!name) return null;
  const description = asString(t.description);
  const schema = extractJsonSchema(t);
  return {
    toolkit,
    name,
    description,
    requiredParams: extractRequiredFromSchema(schema),
    paramKeys: extractPropertiesFromSchema(schema),
    raw: toJsonValue(t),
  };
}

function parseArgs(argv: string[]): { toolkits: string[]; outDir: string } {
  const toolkits: string[] = [];
  let outDir = "artifacts";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--toolkit" || a === "--toolkits") {
      const v = argv[i + 1];
      if (v) {
        toolkits.push(
          ...v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        );
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
  return { toolkits: toolkits.length ? toolkits : ["googlesuper", "github"], outDir };
}

async function loadDotEnvIfPresent(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(".env", "utf-8");
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (k && !(k in process.env)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function main() {
  const { toolkits, outDir } = parseArgs(process.argv.slice(2));

  const fromEnvFile = await loadDotEnvIfPresent();
  for (const [k, v] of Object.entries(fromEnvFile)) process.env[k] = v;

  const composioApiKey = process.env.COMPOSIO_API_KEY;
  if (!composioApiKey) {
    console.error(
      [
        "Missing COMPOSIO_API_KEY.",
        "Fix:",
        "- Run `COMPOSIO_API_KEY=... sh scaffold.sh` (creates .env), then rerun.",
      ].join("\n")
    );
    process.exitCode = 2;
    return;
  }

  const composio = new Composio();

  await mkdir(outDir, { recursive: true });

  const results: {
    toolkit: string;
    rawCount: number;
    normalizedCount: number;
    tools: NormalizedTool[];
  }[] = [];

  for (const toolkit of toolkits) {
    const raw = (await composio.tools.getRawComposioTools({
      toolkits: [toolkit],
      limit: 1000,
    })) as unknown;

    if (!Array.isArray(raw)) {
      console.error(
        `Unexpected response for toolkit="${toolkit}". Expected array, got: ${typeof raw}`
      );
      await writeFile(
        `${outDir}/${toolkit}_raw_tools.unknown.json`,
        JSON.stringify(toJsonValue(raw), null, 2),
        "utf-8"
      );
      continue;
    }

    const normalized = raw
      .map((t) => normalizeTool(toolkit, t as RawTool))
      .filter((x): x is NormalizedTool => Boolean(x));

    results.push({
      toolkit,
      rawCount: raw.length,
      normalizedCount: normalized.length,
      tools: normalized,
    });

    await writeFile(
      `${outDir}/${toolkit}_raw_tools.json`,
      JSON.stringify(raw.map(toJsonValue), null, 2),
      "utf-8"
    );
    await writeFile(
      `${outDir}/${toolkit}_normalized_tools.json`,
      JSON.stringify(normalized, null, 2),
      "utf-8"
    );
  }

  const summary = results.map((r) => ({
    toolkit: r.toolkit,
    rawCount: r.rawCount,
    normalizedCount: r.normalizedCount,
    sample: r.tools.slice(0, 5).map((t) => ({
      name: t.name,
      requiredParams: t.requiredParams,
      paramKeys: t.paramKeys,
    })),
  }));

  await writeFile(
    `${outDir}/step1_summary.json`,
    JSON.stringify(summary, null, 2),
    "utf-8"
  );

  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote artifacts to ${outDir}/`);
}

await main();


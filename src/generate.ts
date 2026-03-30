import { spawnSync } from "node:child_process";

function run(cmd: string, args: string[]) {
  const p = spawnSync(cmd, args, { stdio: "inherit" });
  if (p.error) throw p.error;
  if (p.status !== 0) process.exit(p.status ?? 1);
}

// One-shot entrypoint:
// - Step1: fetch raw tools from Composio and write artifacts/*
// - Step2: build dependency_graph.json
// - Step3: generate dependency_graph.html (visual) and .dot
run("npm", ["run", "-s", "step1:dump-tools"]);
run("npm", ["run", "-s", "step2:build-graph"]);
run("npm", ["run", "-s", "step3:visualize"]);


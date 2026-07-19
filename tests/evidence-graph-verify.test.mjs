import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(".");
const verifierPath = path.join(repoRoot, "scripts", "evidence-graph-verify.mjs");
const smokePath = path.join(repoRoot, "scripts", "evidence-graph-smoke.mjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runVerifier(args, cwd = repoRoot) {
  return spawnSync(process.execPath, [verifierPath, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

function runSmoke(args, cwd = repoRoot) {
  return spawnSync(process.execPath, [smokePath, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
}

function validGraph() {
  return {
    schemaVersion: "cellfence.evidence-graph.v1",
    snapshotDigest: "a".repeat(64),
    nodes: [
      {
        id: "file:1",
        kind: "subject-file",
        label: "src/app/public.ts",
        filePath: "src/app/public.ts",
        digest: "b".repeat(64),
      },
      {
        id: "finding:1",
        kind: "finding",
        label: "CELLFENCE_PRIVATE_IMPORT",
        filePath: "src/app/public.ts",
        ruleId: "CELLFENCE_PRIVATE_IMPORT",
        severity: "error",
      },
      {
        id: "observation:1",
        kind: "observation",
        label: "imports:processed",
        filePath: "src/app/public.ts",
        family: "imports",
        status: "processed",
      },
    ],
    edges: [
      {
        from: "file:1",
        to: "finding:1",
        kind: "reported-finding",
        label: "CELLFENCE_PRIVATE_IMPORT",
      },
      {
        from: "file:1",
        to: "observation:1",
        kind: "observed-as",
        label: "imports",
      },
      {
        from: "finding:1",
        to: "file:1",
        kind: "witnesses",
        label: "filePath",
      },
    ],
    findingWitnesses: [
      {
        ruleId: "CELLFENCE_PRIVATE_IMPORT",
        severity: "error",
        message: "app imports private implementation from core",
        filePath: "src/app/public.ts",
        subjects: [
          { kind: "file", key: "filePath", value: "src/app/public.ts" },
          { kind: "detail", key: "targetPath", value: "src/core/internal.ts" },
        ],
      },
    ],
  };
}

test("evidence graph verifier accepts a structurally complete graph", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-evidence-graph-verify-ok-"));
  try {
    const graphPath = path.join(rootDir, "graph.json");
    writeJson(graphPath, validGraph());
    const result = runVerifier(["--graph", graphPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, "cellfence.evidence-graph-verifier.v1");
    assert.equal(report.ok, true);
    assert.equal(report.summary.findings, 1);
    assert.equal(report.summary.findingWitnesses, 1);
    assert.equal(report.summary.policySupportedFindings, 1);
    assert.equal(report.summary.policyVerifiedFindings, 1);
    assert.equal(report.policy.schemaVersion, "cellfence.evidence-graph-policy-witness-verifier.v1");
    assert.match(report.input.graphCanonicalSha256, /^[a-f0-9]{64}$/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("evidence graph verifier rejects supported policy witnesses without required facts", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-evidence-graph-verify-policy-"));
  try {
    const graph = validGraph();
    graph.findingWitnesses[0] = {
      ...graph.findingWitnesses[0],
      subjects: [
        { kind: "file", key: "filePath", value: "src/app/public.ts" },
      ],
    };
    const graphPath = path.join(rootDir, "graph.json");
    writeJson(graphPath, graph);
    const result = runVerifier(["--graph", graphPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.summary.structuralDefects, 0);
    assert.equal(report.summary.policyDefects, 1);
    assert.ok(report.defects.some((defect) =>
      defect.code === "POLICY_WITNESS_MISSING_SUBJECT"
      && defect.ruleId === "CELLFENCE_PRIVATE_IMPORT"
      && defect.requiredKey === "targetPath"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("evidence graph verifier reports unsupported policy rules without claiming verification", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-evidence-graph-verify-unsupported-"));
  try {
    const graph = validGraph();
    graph.nodes[1] = {
      ...graph.nodes[1],
      label: "CELLFENCE_PUBLIC_SYMBOL_MISMATCH",
      ruleId: "CELLFENCE_PUBLIC_SYMBOL_MISMATCH",
    };
    graph.edges[0] = {
      ...graph.edges[0],
      label: "CELLFENCE_PUBLIC_SYMBOL_MISMATCH",
    };
    graph.findingWitnesses[0] = {
      ...graph.findingWitnesses[0],
      ruleId: "CELLFENCE_PUBLIC_SYMBOL_MISMATCH",
      subjects: [
        { kind: "file", key: "filePath", value: "src/app/public.ts" },
        { kind: "cell", key: "cellId", value: "app" },
      ],
    };
    const graphPath = path.join(rootDir, "graph.json");
    writeJson(graphPath, graph);
    const result = runVerifier(["--graph", graphPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.summary.policySupportedFindings, 0);
    assert.equal(report.summary.policyVerifiedFindings, 0);
    assert.equal(report.summary.policyUnsupportedFindings, 1);
    assert.deepEqual(report.policy.unsupportedRules, ["CELLFENCE_PUBLIC_SYMBOL_MISMATCH"]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("evidence graph verifier can read evidenceGraph from a check result wrapper", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-evidence-graph-verify-wrapper-"));
  try {
    const checkResultPath = path.join(rootDir, "check-result.json");
    const outPath = path.join(rootDir, "verification.json");
    writeJson(checkResultPath, { ok: false, exitCode: 1, evidenceGraph: validGraph() });
    const result = runVerifier(["--check-result", checkResultPath, "--out", outPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.ok, true);
    assert.equal(report.input.source, "check-result");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("evidence graph verifier rejects dangling edges", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-evidence-graph-verify-dangling-"));
  try {
    const graph = validGraph();
    graph.edges[1] = { ...graph.edges[1], to: "observation:missing" };
    const graphPath = path.join(rootDir, "graph.json");
    writeJson(graphPath, graph);
    const result = runVerifier(["--graph", graphPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.defects.some((defect) => defect.code === "UNKNOWN_EDGE_TO"));
    assert.ok(report.defects.some((defect) => defect.code === "OBSERVATION_WITHOUT_OBSERVED_AS_EDGE"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("evidence graph verifier rejects finding nodes without matching witnesses", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-evidence-graph-verify-witness-"));
  try {
    const graph = validGraph();
    graph.findingWitnesses = [];
    const graphPath = path.join(rootDir, "graph.json");
    writeJson(graphPath, graph);
    const result = runVerifier(["--graph", graphPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.defects.some((defect) => defect.code === "FINDING_NODE_WITHOUT_WITNESS_RECORD"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("evidence graph verifier rejects non-canonical ordering and duplicate node ids", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-evidence-graph-verify-order-"));
  try {
    const graph = validGraph();
    graph.nodes = [
      graph.nodes[1],
      graph.nodes[0],
      graph.nodes[0],
      graph.nodes[2],
    ];
    const graphPath = path.join(rootDir, "graph.json");
    writeJson(graphPath, graph);
    const result = runVerifier(["--graph", graphPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.defects.some((defect) => defect.code === "NODES_NOT_CANONICALLY_SORTED"));
    assert.ok(report.defects.some((defect) => defect.code === "DUPLICATE_NODE_ID"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("evidence graph verifier rejects invalid edge shapes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-evidence-graph-verify-edge-shape-"));
  try {
    const graph = validGraph();
    graph.edges[1] = {
      from: "finding:1",
      to: "observation:1",
      kind: "observed-as",
      label: "imports",
    };
    const graphPath = path.join(rootDir, "graph.json");
    writeJson(graphPath, graph);
    const result = runVerifier(["--graph", graphPath]);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.ok(report.defects.some((defect) => defect.code === "INVALID_OBSERVED_AS_EDGE_SHAPE"));
    assert.ok(report.defects.some((defect) => defect.code === "OBSERVATION_WITHOUT_OBSERVED_AS_EDGE"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("evidence graph smoke validates graph emitted by the engine", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-evidence-graph-smoke-"));
  try {
    const outPath = path.join(rootDir, "smoke.json");
    const result = runSmoke(["--workdir", path.join(rootDir, "work"), "--out", outPath]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /evidence graph smoke passed/);
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(report.schemaVersion, "cellfence.evidence-graph-smoke.v1");
    assert.equal(report.check.exitCode, 1);
    assert.ok(report.check.findingRules.includes("CELLFENCE_PRIVATE_IMPORT"));
    assert.equal(report.verifier.ok, true);
    assert.equal(report.verifier.summary.policyVerifiedFindings, 1);
    assert.equal(fs.existsSync(report.verifierReportPath), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("evidence graph smoke rejects missing option values without deleting cwd children", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cellfence-evidence-graph-smoke-missing-"));
  try {
    const sentinelPath = path.join(rootDir, "run-sentinel", "sentinel.txt");
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, "do not delete");
    const result = runSmoke(["--workdir"], rootDir);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--workdir requires a value/);
    assert.equal(fs.readFileSync(sentinelPath, "utf8"), "do not delete");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

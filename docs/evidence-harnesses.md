# Product Evidence Harnesses

CellFence keeps product checks separate from evidence collection. These harnesses make real-repository and external-oracle measurements reproducible; they do not turn unlabeled findings into precision claims.

The SARIF gate always validates output against the vendored official OASIS SARIF 2.1.0 Errata 01 schema and compares every result with CellFence JSON output. A separately provisioned command-line validator is optional additional evidence; CI retains all oracle reports even when one oracle fails.

Analyzer descriptors are trusted, pre-provisioned executable code. The harness never enables a shell and never performs a target-repository install itself; argument screening rejects common shell, inline-code, and package-manager indirection, but it is defense in depth rather than a process sandbox. Run third-party analyzers in an external container or VM when their descriptor is not trusted.

## Resolution Oracles

Run the deterministic local oracle suite with:

```bash
npm run conformance:oracles
```

The TypeScript harness compares CellFence with `ts.resolveModuleName` across relative runtime extensions, path aliases, package imports, package names, and package export subpaths. The Python harness compares local modules with `importlib.util.find_spec` across flat, `src`, `pyproject.toml`, `setup.cfg`, and relative-import layouts. The SARIF harness validates output against the vendored OASIS SARIF 2.1.0 Errata 01 schema and compares SARIF results with the same check's JSON findings.

An oracle divergence exits nonzero. Cases without equivalent semantics are reported as `not_comparable`; they are not counted as agreement.

## Exact-Commit Corpus

Create or extend a corpus through GitHub search:

```bash
npm run evidence:github-corpus -- \
  --query "language:TypeScript stars:>=1000" \
  --base-corpus corpus.json \
  --out corpus-expanded.json \
  --limit 25
```

The collector resolves each default branch to a 40-character commit SHA and deduplicates repositories. Review and freeze the resulting subject list before drawing conclusions; search ranking is a selection policy, not a random sample.

Run CellFence and optional pre-provisioned analyzers over that corpus:

```bash
npm run evidence:corpus -- \
  --corpus corpus-expanded.json \
  --analyzers analyzers.json \
  --discard-checkouts \
  --out reports/product-evidence-corpus.json
```

The harness never installs dependencies in target repositories and refuses package-manager or shell analyzer commands. It checks out exact commits, verifies a clean worktree before and after every trusted analyzer, applies timeouts, records exit classification, findings, source KLOC, latency, and ms/KLOC, and preserves failures in the report. Optional analyzers must already be installed by the operator.

## Competitor Comparison

`npm run evidence:competitors -- ...` compares normalized, pre-provisioned analyzer output. It reports common, competitor-only, and CellFence-only evidence without calling either side correct. Dependency-cruiser, import-linter, and madge have different policy models, so the comparison is a mechanism and coverage-gap oracle, not a precision score.

## Adversarial Evidence

`npm run evidence:adversarial:verify -- --input attempts.json --fixtures-root fixtures` replays submitted bypass attempts with the local built CLI. Inputs pin the complete fixture tree, manifest, witness file and line range, and historical command evidence. Paths and symlinks are contained beneath the supplied fixture root; the verifier does not install, use a shell, access the network, or modify tests.

Results are `blocked`, `reproduced_bypass`, `invalid_setup`, or `tool_error`. A reproduced bypass exits nonzero and emits promotion metadata for a later human-reviewed minimal regression fixture. It is never added to the test suite automatically.

## Claim Boundary

These reports establish reproducibility, robustness, oracle agreement, and candidate gaps. Precision still requires a frozen reviewed manifest, a declared claim profile, independent labels, adjudication, and the existing claim preflight. Inferred manifests and agent-only labels remain outside the external human or organization claim lane.

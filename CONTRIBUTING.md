# Contributing

CellFence changes should keep the implementation narrow and the specification honest.

Before submitting a change, run:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run cellfence:self-check
```

Do not relax fixture expectations to hide implementation defects. If a fixture reveals an ambiguity, record the ambiguity in the change description and update the protocol only when the intended rule is clear.

Publishing is intentionally not automated in v0.x. Future npm publishing should use GitHub OIDC trusted publishing rather than long-lived package tokens.

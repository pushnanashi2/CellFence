# Ownership Conformance

This ledger pins ownership semantics that must stay stable across engine refactors.

The cases cover:

- sibling path prefixes such as `src/user/**` and `src/users/**`
- true nested ownership overlap
- wildcard ownership overlap
- root-file glob behavior
- public entries outside owned paths
- produced artifact lanes outside owned paths
- strict unowned source coverage
- the warning emitted when ownership coverage is disabled

Run it with:

```sh
npm run conformance:ownership
```

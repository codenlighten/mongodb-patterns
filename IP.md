# IP records

| Date | Covers | Type | Record hash | Signer | Tag |
|---|---|---|---|---|---|
| 2026-11-26 | Commit `2d2bf11`: MongoDB studies in TypeScript with tests and documentation. No authorship claimed in MongoDB itself, third-party libraries, the established techniques studied and the generated lockfile. | software, hash-only | [`95fd64711d7cb3ceb40807df0f357cbdd33f036b69ad9bd67f24072bdcdcced7`](https://iptrust.org/v/95fd64711d7cb3ceb40807df0f357cbdd33f036b69ad9bd67f24072bdcdcced7) | Gregory J. Ward | `ip-2026-11-26` |

A record is evidence that the committed content existed by the time of its anchor and that the signer made
the statement; it does not create or register any right. Anchoring completes some hours after submission.
Files under `third_party/`, where present, are not part of the record.

## Verifying

Verification needs the evidence package for the record, which the author holds and which is not committed
here. With it in `.iptrust/`:

```
git worktree add /tmp/at-tag-mongodb-patterns ip-2026-11-26
cp -r .iptrust /tmp/at-tag-mongodb-patterns/
(cd /tmp/at-tag-mongodb-patterns && iptrust2 verify 95fd64711d7cb3ceb40807df0f357cbdd33f036b69ad9bd67f24072bdcdcced7 --fetch-headers)
git worktree remove --force /tmp/at-tag-mongodb-patterns
```

Expect `verdict: valid` and `content: matched` once both chains have anchored.

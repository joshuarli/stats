Prefix: STA
Next: 31

### STA-30 · P4 · Block snapshot freshness and mode checks are untested

- **Area:** Tests
- **Where:** `agent/src/block.rs:67-85`, `agent/src/block.rs:140-178`
- **Problem:** `read_snapshot` rejects a snapshot older than 30 seconds or writable by group or other, and `bpf/README.md` states both conditions. The tests cover parsing, canonical decimals, and attaching each snapshot once, but not the age or mode rejection; removing either check leaves the suite green.
- **Recommendation:** Add tests for a stale snapshot and a group-writable snapshot. The owner check needs root to exercise and can stay covered by inspection.
- **Fix with:** test-audit
- **Effort:** S

# Tenfold fixture

[metadata.json](metadata.json) identifies the private 203,950-event fixture built
from the frozen 20,395-event production corpus. Only event IDs change. They stay
36 characters, are deterministic and unique, and preserve the exact serialized
byte length of every source event. Operation, outcome, duration, attributes and
timestamps remain unchanged across all ten copies. The source covers about
25 hours within the seven-day retention window; this does not create seven
days of continuous traffic.

The generator verifies the source checksum, count, unique IDs, complete event
equality after restoring each original ID, and exact tenfold event bytes.
The raw fixture stays in protected backup storage and is not committed.

```sh
node bench/scale-application-corpus.mjs \
  --input PRIVATE_DIRECTORY/corpus.json \
  --output PRIVATE_DIRECTORY/corpus-10x.json
```

The command and `node --check bench/scale-application-corpus.mjs` exit 0.
This is workload preparation. Native ingestion, correctness, concurrency and
latency acceptance remain open.

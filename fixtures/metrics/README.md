# Infrastructure metrics captures

`v1/scrapes/standby-engine.prom` is a trimmed capture from the native standby
Engine on 127.0.0.1:6430 on 2026-11-20 (capture file modified at
08:20:04 America/Los_Angeles). Its image digest was
`sha256:6e585002b700dd4d3630808eb67884aa15d1a602d83781984edac47023b6d40f`;
it self-reported Rivet 3.1.1. The retained lines include the catalog's Engine
families and a non-admitted Tokio family. No credentials or non-loopback
hostnames occur in the retained lines.

The `serve-*` captures came from the OpenOrange checkout at branch
`campaign/multi-worker-metrics`, using its `orange serve exposes each Worker's
metrics and a new start time after restart` test harness on 2026-11-20. Both
Workers were fetched around 08:21 America/Los_Angeles before and after restarting the serve process against the
same real local Engine. The final numeral orders the captures; 1 and 3 are
Worker 1 before and after restart. The test fixture workers are `serve-primary`
and `serve-peer`. These are endpoint responses, not synthetic expositions.

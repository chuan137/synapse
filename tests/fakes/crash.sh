#!/bin/sh
# spec §4.5: exits 1 with stderr — wrapper must capture the stderr tail in result_summary.
echo "crash.sh: simulated failure on stderr" >&2
exit 1

#!/bin/bash
FLEET=/tmp/aed-loadtest/fleet.json
PID=$(systemctl show aedresponse -p MainPID --value)
echo "### MainPID=$PID  state=$(stat -c%s /var/lib/aedresponse/state.sqlite 2>/dev/null || sudo stat -c%s /var/lib/aedresponse/state.sqlite) bytes"
echo "### $(date -u +%FT%TZ)"
for C in 1 2 4 8 16 32 64 128; do
  /opt/node/bin/node /tmp/aed-loadtest/loadgen.mjs sat events $C 20 --pid=$PID --fleet=$FLEET 2>&1 | grep -E "RESULT|serverCpu|statuses"
done
for C in 16 64 128; do
  /opt/node/bin/node /tmp/aed-loadtest/loadgen.mjs sat putposition $C 20 --pid=$PID --fleet=$FLEET 2>&1 | grep -E "RESULT|serverCpu|statuses"
done
for C in 32 128; do
  /opt/node/bin/node /tmp/aed-loadtest/loadgen.mjs sat presence $C 20 --pid=$PID --fleet=$FLEET 2>&1 | grep -E "RESULT|serverCpu|statuses"
done
for C in 64 128 256; do
  /opt/node/bin/node /tmp/aed-loadtest/loadgen.mjs sat healthz $C 15 --pid=$PID --fleet=$FLEET 2>&1 | grep -E "RESULT|serverCpu|statuses"
done
/opt/node/bin/node /tmp/aed-loadtest/loadgen.mjs sat aeds 64 15 --pid=$PID --fleet=$FLEET 2>&1 | grep -E "RESULT|serverCpu|statuses"
/opt/node/bin/node /tmp/aed-loadtest/loadgen.mjs sat nearby 64 15 --pid=$PID --fleet=$FLEET 2>&1 | grep -E "RESULT|serverCpu|statuses"
echo "### done $(date -u +%FT%TZ)"

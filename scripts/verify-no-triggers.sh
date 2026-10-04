#!/usr/bin/env bash
#
# Prove the Trigger architecture is gone.
#
# The claim "Tracker is the observation architecture, not a rename of
# something else" is only worth anything if it can be re-checked, so this
# is a script rather than a paragraph in a document. It exits non-zero the
# moment a Trigger symbol reappears, which turns the migration into
# something CI can enforce instead of something a reviewer has to
# remember.
#
# Three passes:
#   1. Domain symbols — code that would mean a second architecture, or a
#      facade over the deleted one.
#   2. Paths         — a file or directory named for the old architecture.
#   3. Prose         — reported, not gating, because some uses of the word
#      are ordinary English.
#
# The symbol pass is the one that gates.

set -uo pipefail

ROOTS=(src watchers/src watchers/test server/tradingv_engine shared)
CODE=(--include=*.ts --include=*.tsx --include=*.py --include=*.json --include=*.sh)
# Built/vendor directories, as individual --exclude-dir flags.
#
# This is an array of whole flags rather than bare names: `--exclude-dir=a b`
# excludes only "a" and then searches for the *files* "b" and "c", which
# produced phantom hits in the first version of this script.
BUILT_FLAGS=(--exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=.wrangler --exclude-dir=dist)

cd "$(dirname "$0")/.." || exit 1

echo "=============================================================="
echo " 1. Trigger domain symbols"
echo "=============================================================="

SYMBOLS=(
  AgentTrigger AgentTriggerEvent TriggerEngine TriggerRegistry TriggerType
  TriggerCondition TriggerEvent TriggerMarketState TriggerInput
  TriggerRegistry TriggerAgentResolver TriggerSpec TriggerDelivery
  TriggerEvaluationState TriggerInput TriggerMarketStateSnapshot
  evaluateTrigger calculateTriggerIndicators registerTrigger
  unregisterTrigger updateTrigger deleteTrigger createTrigger
  triggerRegistry triggerEngine triggerId triggerType triggerConfig
  trigger_error triggerCount lastTriggeredAt maxFiringsPerMinute
  TRIGGER_FIRED TRIGGER_SUPPRESSED TRIGGER_UNKNOWN
  replayTriggersBacktest runTriggerTimelineTests runHyperliquidTriggerIntegrationTest
  RegisterTriggerRequest ingestTriggerEvent
)

failed=0
for sym in "${SYMBOLS[@]}"; do
  hits=$(grep -rlE "${BUILT_FLAGS[@]}" "(^|[^A-Za-z0-9_])${sym}([^A-Za-z0-9_]|$)" "${ROOTS[@]}" "${CODE[@]}" 2>/dev/null)
  if [ -z "$hits" ]; then count=0; else count=$(printf '%s\n' "$hits" | grep -c .); fi
  if [ "$count" -eq 0 ]; then
    printf '  ok       %s\n' "$sym"
  else
    printf '  PRESENT  %-24s %s file(s)\n' "$sym" "$count"
    printf '%s\n' "$hits" | sed 's/^/             /'
    failed=1
  fi
done

echo
echo "=============================================================="
echo " 2. Trigger API paths"
echo "=============================================================="
# The old REST surface. A compatibility route would defeat the point of
# the migration, so this is a hard failure rather than a note.
route_hits=$(grep -rnE "${BUILT_FLAGS[@]}" "['\"\`]/triggers(/|['\"\`])" "${ROOTS[@]}" "${CODE[@]}" 2>/dev/null)
if [ -z "$route_hits" ]; then
  echo "  ok       no /triggers route"
else
  printf '  PRESENT\n%s\n' "$route_hits" | sed 's/^/             /'
  failed=1
fi

echo
echo "=============================================================="
echo " 3. Filenames carrying trigger terminology"
echo "=============================================================="
files=$(find src watchers/src watchers/test server/tradingv_engine shared -type f \
  -not -path "*/node_modules/*" -not -path "*/.venv/*" \
  -not -path "*/__pycache__/*" 2>/dev/null \
  | grep -Ei '(^|[^a-z])trigger(s)?([^a-z]|$)' || true)
if [ -z "$files" ]; then
  echo "  ok       no trigger-named files"
else
  printf '  PRESENT\n%s\n' "$files" | sed 's/^/             /'
  failed=1
fi

echo
echo "=============================================================="
echo " 4. Facade shapes that would re-create the old architecture"
echo "=============================================================="
# The migration is only real if the new names are the implementation. A
# TrackerRuntime that delegates to a trigger engine, a Tracker that
# extends an AgentTrigger, or a TrackerEvent that wraps one, is the
# rejection from the brief wearing a hat.
FACADES=(
  "TrackerRuntime[^;]*TriggerEngine"
  "TrackerRegistry[^;]*TriggerRegistry"
  "extends[ ]+AgentTrigger"
  "implements[ ]+AgentTrigger"
  "new[ ]+TrackerEvent\(.*TriggerEvent"
  "from[ ]+['\"].*agents/triggers"
  "from[ ]+['\"].*/triggers/"
)
for pattern in "${FACADES[@]}"; do
  hits=$(grep -rlE "${BUILT_FLAGS[@]}" "${pattern}" "${ROOTS[@]}" "${CODE[@]}" 2>/dev/null)
  if [ -z "$hits" ]; then count=0; else count=$(printf '%s\n' "$hits" | grep -c .); fi
  if [ "$count" -eq 0 ]; then
    printf '  ok       %s\n' "$pattern"
  else
    printf '  PRESENT  %s\n' "$pattern"
    printf '%s\n' "$hits" | sed 's/^/             /'
    failed=1
  fi
done

echo
echo "=============================================================="
echo " 5. Prose (reported, not gating)"
echo "=============================================================="
# Reported rather than failed: `suggestOnTriggerCharacters` is a Monaco
# option, "edge-triggered" is signal-processing English, and one
# regression test deliberately names the retired `triggers` field to
# prove it cannot come back. A check that cannot tell those apart from a
# live architecture is a check that gets disabled.
prose=$(grep -rniE "${BUILT_FLAGS[@]}" '\btrigger(s|ed|ing)?\b' \
  "${ROOTS[@]}" "${CODE[@]}" 2>/dev/null | wc -l)
echo "  $prose line(s) mention 'trigger'. Review these by hand:"
grep -rniE "${BUILT_FLAGS[@]}" '\btrigger(s|ed|ing)?\b' \
  "${ROOTS[@]}" "${CODE[@]}" 2>/dev/null | head -30 | sed 's/^/             /'

echo
echo "=============================================================="
if [ "$failed" -eq 0 ]; then
  echo " RESULT: the Trigger architecture is gone. Tracker is canonical."
  echo "=============================================================="
  exit 0
fi
echo " RESULT: Trigger domain symbols or a facade over them remain."
echo "=============================================================="
exit 1

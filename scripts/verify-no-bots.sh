#!/usr/bin/env bash
#
# Prove the Bot architecture is gone.
#
# The claim "there is one trading-agent architecture" is only worth
# anything if it can be re-checked, so this is a script rather than a
# paragraph in a document. It exits non-zero the moment a Bot symbol
# reappears, which turns the migration into something CI can enforce
# instead of something a reviewer has to remember.
#
# Two passes:
#   1. Domain symbols — code that would mean a second architecture.
#   2. Prose        — user-facing or developer-facing "bot" language.
#
# Prose is reported rather than failed: some references are legitimate
# (a changelog saying "formerly a bot"), and this script is not the
# place to adjudicate that. The domain pass is the one that gates.

set -uo pipefail

ROOTS=(src watchers/src watchers/test server/tradingv_engine shared)
CODE=(--include=*.ts --include=*.tsx --include=*.py --include=*.json)
# Built/vendor directories, as individual --exclude-dir flags.
#
# This is an array of whole flags rather than bare names: `--exclude-dir=a b`
# excludes only "a" and then searches for the *files* "b" and "c", which
# produced phantom hits in the first version of this script.
BUILT_FLAGS=(--exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=.wrangler --exclude-dir=dist)

cd "$(dirname "$0")/.." || exit 1

echo "=============================================================="
echo " 1. Bot domain symbols"
echo "=============================================================="

SYMBOLS=(
  BotDefinition BotTrigger BotRegistry BotEngine BotService BotStore
  BotDeployment BotSource BotStatus EXPLORER_BOTS
  registerBot registerBotTriggers compileBotDefinition
  validateBotDefinition migrateBotDefinition createDeployment
  runBotDefinitionBacktest botDefinition botConfig botId botName
  BotsTab BotBuilderModal TriggerBuilder
)

failed=0
for sym in "${SYMBOLS[@]}"; do
  hits=$(grep -rlE "${BUILT_FLAGS[@]}" "(^|[^A-Za-z0-9_])${sym}([^A-Za-z0-9_]|\$)" "${ROOTS[@]}" "${CODE[@]}" 2>/dev/null)
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
echo " 2. Filenames carrying bot terminology"
echo "=============================================================="
# `-iname '*bot*'` matched BottomNav and BottomPanel, which have nothing
# to do with this. Matching the word rather than the substring is the
# difference between a check that is trusted and one that gets ignored.
files=$(find src watchers/src server/tradingv_engine shared -type f \
  -not -path "*/node_modules/*" -not -path "*/.venv/*" \
  -not -path "*/__pycache__/*" 2>/dev/null \
  | grep -Ei '(^|[^a-z])bots?([^a-z]|$)' || true)
if [ -z "$files" ]; then
  echo "  ok       no bot-named files"
else
  printf '  PRESENT\n%s\n' "$files" | sed 's/^/             /'
  failed=1
fi

echo
echo "=============================================================="
echo " 3. Prose (reported, not gating)"
echo "=============================================================="
prose=$(grep -rniE "${BUILT_FLAGS[@]}" '\bbots?\b' \
  "${ROOTS[@]}" "${CODE[@]}" 2>/dev/null | wc -l)
echo "  $prose line(s) mention 'bot'. Review these by hand:"
grep -rniE "${BUILT_FLAGS[@]}" '\bbots?\b' \
  "${ROOTS[@]}" "${CODE[@]}" 2>/dev/null | head -30 | sed 's/^/             /'

echo
echo "=============================================================="
if [ "$failed" -eq 0 ]; then
  echo " RESULT: the Bot architecture is gone."
  echo "=============================================================="
  exit 0
fi
echo " RESULT: Bot domain symbols remain. See above."
echo "=============================================================="
exit 1

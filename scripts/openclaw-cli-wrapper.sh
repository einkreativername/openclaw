#!/bin/sh
# OpenClaw CLI dispatcher.
#
# Upstream OpenClaw has no "tools" command: "tool" and "tools" are reserved
# non-plugin command roots (src/cli/command-registration-policy.ts), and no
# core command registers them. The only upstream "tools" is the MCP filter
# subcommand "openclaw mcp tools".
#
# This wrapper keeps every other invocation on the untouched upstream launcher
# and routes only the reserved root to the skill dispatcher:
#
#   openclaw tools list --json
#   openclaw tools info <skill> [--json]
#   openclaw tools check [--json]
#   openclaw tools call <skill> [action] '<json-payload>'
#
# The dispatcher is a separate file (/app/openclaw-tools.mjs) so that the
# upstream launcher stays byte-identical to the shipped image.

set -eu

if [ "${1:-}" = "tools" ]; then
  shift
  exec node /app/openclaw-tools.mjs "$@"
fi

exec node /app/openclaw.mjs "$@"

#!/bin/bash
# Mnemopi MCP Server Startup Script
export MNEMOPI_DATA_DIR="$HOME/.hermes/mnemopi/data"
exec bun run node_modules/@oh-my-pi/pi-mnemopi/src/cli.ts mcp --transport stdio

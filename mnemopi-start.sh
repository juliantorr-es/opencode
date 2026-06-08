#!/bin/bash
# Start mnemopi MCP server
exec bun run node_modules/@oh-my-pi/pi-mnemopi/src/cli.ts mcp --transport stdio "$@"

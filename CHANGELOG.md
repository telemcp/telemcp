# Changelog

## 0.1.1

* Docker image builds on arm64 and amd64 (build tools in the build stage).
* Install straight from GitHub with npx (the package builds on install).

## 0.1.0

* First release: Telegram MCP server for user accounts (MTProto with your own api_id and api_hash) and bots.
* Door contract 1.0 tools: list_accounts, send_message, get_message, list_messages, wait_for_messages, get_usage, list_chats, list_groups, list_channels, search_messages, mark_read, connect_telegram, submit_telegram_code, submit_telegram_password, get_telegram_status, disconnect_telegram.
* Local SQLite store with full text search and a send ledger.
* Daily message and new contact caps, pacing, typing indicator, FLOOD_WAIT and PEER_FLOOD handling.
* stdio and local Streamable HTTP transports, Docker image, MCP registry metadata.

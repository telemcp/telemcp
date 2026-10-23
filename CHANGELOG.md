# Changelog

## 0.1.2 (2026-10-23)

Tool schemas now match the hosted API field for field. Breaking changes are marked.

* Breaking: `send_message` needs `text` (up to 4096 characters; it is the caption when media is attached). A media only send is no longer possible.
* Breaking: `to.telegram_user_id` is a string.
* Breaking: `connect_telegram` takes `phone_number` (was `phone`), plus `mode` (`code`; QR login is refused) and `force_new` (log out the saved session and start a fresh login).
* Breaking: `submit_telegram_code`, `submit_telegram_password`, `get_telegram_status` and `disconnect_telegram` need `phoneNumber`. A number that is not this server's number is refused.
* Breaking: the connection tools answer `{success: true, phone_number, status, ...}` and refuse with `{success: false, error_code: <HTTP status>, error}`. `get_telegram_status` reports `connected`, `code_required`, `password_required`, `initializing`, `disconnected`, `not_initialized` or `error`, with `telegram_user_id`, `live` and `limits`. `disconnect_telegram` reports `removed`.
* Breaking: an unknown `account_id` is `account_not_found` (was `no_connected_account`).
* Breaking: new, more specific error codes: `invalid_text`, `invalid_media_url` (a malformed or non https `media_url`; `media_unavailable` stays for media that cannot be fetched or read), `invalid_reply_to`, `invalid_chat_id`, `invalid_cursor`, `invalid_query`.
* An unknown `chat_id` used as a filter on `list_messages`, `wait_for_messages` and `search_messages` returns an empty list instead of an error.
* `send_message` accepts `opt_in` and reports `reply_to_applied`.
* `list_accounts` lists the channel, `list_chats` items carry `channel`, `mark_read` reports `receipt_sent`.
* `get_usage` reports `status`, `accounts_total`, `accounts_connected`, `accounts_cap` and `ramp_day`.
* `search_messages` needs a `query` of 2 to 200 characters; `list_chats` limits `query` to 200 characters.

## 0.1.1

* Docker image builds on arm64 and amd64 (build tools in the build stage).
* Install straight from GitHub with npx (the package builds on install).

## 0.1.0

* First release: Telegram MCP server for user accounts (MTProto with your own api_id and api_hash) and bots.
* Door contract 1.0 tools: list_accounts, send_message, get_message, list_messages, wait_for_messages, get_usage, list_chats, list_groups, list_channels, search_messages, mark_read, connect_telegram, submit_telegram_code, submit_telegram_password, get_telegram_status, disconnect_telegram.
* Local SQLite store with full text search and a send ledger.
* Daily message and new contact caps, pacing, typing indicator, FLOOD_WAIT and PEER_FLOOD handling.
* stdio and local Streamable HTTP transports, Docker image, MCP registry metadata.

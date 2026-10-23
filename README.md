# telemcp: Telegram MCP server

telemcp is an open source Telegram MCP server that connects your own Telegram account (or a bot) to Claude and other AI assistants. It runs on your machine, reads, searches and sends your Telegram messages, and stores everything in a local database. Free and MIT licensed.

Don't want to run it yourself? A hosted version is coming at telemcp.com.

```bash
npx -y github:telemcp/telemcp login
claude mcp add telemcp -- npx -y github:telemcp/telemcp
```

## What you can ask your assistant

* "Summarise what happened in the Book Club group today."
* "Search my Telegram for the invoice Anna sent in March."
* "Reply to Jonas that Thursday works."
* "Wait for a reply from @alice and tell me what she says."

## Quick start

You need Node.js 20 or newer and a Telegram account.

1. Get your own API credentials. telemcp never ships shared ones.
   1. Open https://my.telegram.org and log in with your phone number.
   2. Click **API development tools**.
   3. Create an application. Any app title and short name will do.
   4. Copy the **api_id** and **api_hash** shown on the page.
2. Log in from a terminal:

   ```bash
   npx -y github:telemcp/telemcp login
   ```

   It asks for the api_id, the api_hash, your phone number, the login code Telegram sends you, and your two step verification password if you set one. The session is saved in `~/.telemcp/session`, readable only by you.
3. Add telemcp to your AI assistant with one of the blocks below and restart the assistant.

You can also pass the credentials through the environment instead of typing them: `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`.

## Add it to your assistant

### Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config):

```json
{
  "mcpServers": {
    "telemcp": {
      "command": "npx",
      "args": ["-y", "github:telemcp/telemcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add telemcp -- npx -y github:telemcp/telemcp
```

### OpenClaw

```bash
openclaw mcp add telemcp --command npx --arg -y --arg github:telemcp/telemcp
```

or as a JSON server object:

```bash
openclaw mcp set telemcp '{"command":"npx","args":["-y","github:telemcp/telemcp"]}'
```

### Cursor

Add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "telemcp": {
      "command": "npx",
      "args": ["-y", "github:telemcp/telemcp"]
    }
  }
}
```

### Any other MCP client

telemcp speaks MCP over stdio by default: run `npx -y github:telemcp/telemcp`. For clients that connect over HTTP, start it on your own machine:

```bash
npx -y github:telemcp/telemcp serve --http --port 8788 --token choose-a-long-secret
```

The endpoint is `http://127.0.0.1:8788/mcp`; send the token as `Authorization: Bearer choose-a-long-secret`. It only listens on 127.0.0.1.

### Docker

Log in once, then run the server with the same volume:

```bash
docker run -it --rm -v telemcp-data:/data ghcr.io/telemcp/telemcp login
docker run -i --rm -v telemcp-data:/data ghcr.io/telemcp/telemcp
```

As an MCP client entry:

```json
{
  "mcpServers": {
    "telemcp": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "telemcp-data:/data", "ghcr.io/telemcp/telemcp"]
    }
  }
}
```

## Bot mode

telemcp can run as a Telegram bot instead of your user account. Create a bot with @BotFather, then:

```bash
npx -y github:telemcp/telemcp login --bot-token 123456:ABC...
```

or set `TELEMCP_BOT_TOKEN` (with `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`) and start the server; it logs the bot in by itself. Bots still connect through MTProto, so they also need an api_id and api_hash.

Telegram limits what bots can do. A bot only sees messages sent to it after it joined a chat, and it can only message people who started a chat with it first. In bot mode `list_chats`, `list_messages` and `search_messages` answer from the messages the bot has received and stored locally; `mark_read` and sending by phone number return `not_available_for_bots`.

## Tools

telemcp follows door-contract 1.0 (`contract/door-contract.json`), which defines the tool names, input fields and error codes.

| Tool | What it does |
| --- | --- |
| `list_accounts` | The connected Telegram account (there is exactly one) and the channel it uses. |
| `get_telegram_status` | Connection status (`phoneNumber`), today's limits, and what to do next when not connected. |
| `connect_telegram` | Start a login from the assistant with `phone_number` (international format): sends the login code to your phone. `mode` is `code` (QR login is not supported here); `force_new: true` logs out the saved session first. |
| `submit_telegram_code` | Finish the login with `phoneNumber` and `code`. |
| `submit_telegram_password` | Finish the login with `phoneNumber` and your two step verification `password`. |
| `disconnect_telegram` | Log out (`phoneNumber`) and delete the saved session. |
| `list_chats` | Chats, most recent first, with unread counts. Filter by name or by type `user`, `group` or `channel`. |
| `list_groups` | Groups and supergroups. |
| `list_channels` | Broadcast channels. |
| `list_messages` | Messages newest first, for one chat or all chats, inbound or outbound, with a cursor for older pages. |
| `get_message` | One message by id. |
| `search_messages` | Telegram's own search (user accounts) plus full text search over the local database. `query` is 2 to 200 characters. |
| `send_message` | Send text, an image or a file to exactly one recipient: `telegram_username`, `telegram_user_id` (as a string), `phone` (someone in your contacts) or `contact_id` (any chat id). `text` is required (up to 4096 characters; the caption when media is attached). Supports `reply_to`, `media_url` (https), `media_path` (a local file) and `opt_in` (accepted and logged). |
| `wait_for_messages` | Wait up to 55 seconds for new inbound messages; pass the returned cursor to the next call. |
| `mark_read` | Mark a chat as read and send the read receipt. |
| `get_usage` | Today's sends and new contacts against the daily caps, account status and account counts. |

There is no bulk send tool. Every `send_message` call has one recipient.

An unknown `chat_id` used as a filter on `list_messages`, `wait_for_messages` or `search_messages` returns an empty list.

The phone number tools take the number in two spellings: `connect_telegram` takes `phone_number`, the others take `phoneNumber`. A `phoneNumber` that is not this server's number is refused with error code 404. In bot mode there is no phone number: any value is accepted and `phone_number` is null.

When a tool refuses, the result is JSON like `{"error_code": "daily_send_cap", "error": "...", "retry_after_s": 3600}`. Codes: `no_connected_account`, `account_not_found`, `account_suspended`, `invalid_recipient`, `contact_not_found`, `message_not_found`, `needs_inbound_first`, `daily_send_cap`, `new_contact_cap`, `rate_limited`, `media_unavailable`, `invalid_media_url`, `invalid_text`, `invalid_reply_to`, `invalid_chat_id`, `invalid_cursor`, `invalid_query`, `not_available_for_bots`, `code_required`, `password_required`, `invalid_code`, `invalid_input`, `telegram_error`.

The connection tools (`connect_telegram`, `submit_telegram_code`, `submit_telegram_password`, `get_telegram_status`, `disconnect_telegram`) answer `{"success": true, "phone_number": "+31...", "status": "..."}` and refuse with an HTTP style status: `{"success": false, "error_code": 404, "error": "No connection for that number."}` (400 invalid input, code or password; 403 account suspended; 404 not connected or another number; 409 code or password asked out of order; 429 rate limited, with `retry_after_s`; 502 any other Telegram error).

## Safety limits

The limits live in `~/.telemcp/config.json`. Edit the file and the running server uses the new values on the next send. `telemcp limits` prints them with today's usage.

```json
{
  "limits": {
    "daily_message_cap": 200,
    "daily_new_contact_cap": 20,
    "new_contact_delay_seconds": { "min": 45, "max": 120 },
    "send_delay_seconds": { "min": 1, "max": 3 },
    "typing_indicator": true
  }
}
```

* **daily_message_cap**: messages sent per day, across all chats. Resets at local midnight.
* **daily_new_contact_cap**: first messages per day to people you have never exchanged a message with in a private chat.
* **new_contact_delay_seconds**: after a message to a new contact, the next new contact has to wait a random time in this range.
* **send_delay_seconds**: a short random pause between any two sends.
* **typing_indicator**: a user account shows "typing" for a moment, longer for longer texts, before it sends.

How telemcp reacts to Telegram:

* **FLOOD_WAIT**: telemcp never retries inside the wait. It returns `rate_limited` with the number of seconds Telegram asked for, and pauses all sends until that time has passed.
* **PEER_FLOOD**: Telegram is limiting messages to people who have not talked to you. telemcp stops new contact sends until local midnight and says why. Messages to existing chats keep working.
* **Session ended or account deactivated** (`AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED`, `USER_DEACTIVATED`, `USER_DEACTIVATED_BAN`): telemcp stops, remembers it, and tells you to check the account and run `telemcp login`.

## Where your data lives

Everything stays in one folder on your machine, `~/.telemcp` (set `TELEMCP_HOME` to move it):

| File | What it is |
| --- | --- |
| `session` | Your Telegram login session. Anyone with this file can use your account, so it is created readable only by you (mode 600). |
| `config.json` | Mode, your api_id and api_hash, and the limits. Mode 600. |
| `telemcp.db` | SQLite database with chats, users, messages (with a full text index) and a ledger of what was sent. |

telemcp only talks to Telegram's servers. No telemetry, no update checks, no hosted API. When you send a `media_url`, telemcp hands the URL to Telegram and Telegram fetches the file.

Logs go to stderr only.

## Commands

```text
telemcp login [--bot-token TOKEN] [--api-id ID --api-hash HASH] [--phone +31...]
telemcp [serve]                  MCP server on stdio
telemcp serve --http [--port 8788] [--token SECRET]
telemcp status                   login state and today's usage
telemcp limits                   the safety limits and where to change them
telemcp logout                   end the session and delete it
```

## FAQ

### Is there a Telegram MCP server?

Yes. telemcp is an open source Telegram MCP server. It connects your Telegram account or a bot to Claude Desktop, Claude Code, Cursor, OpenClaw and any other MCP client, runs on your own machine and is free under the MIT license. Don't want to run it yourself? A hosted version is coming at telemcp.com.

### Should I use my user account or a bot?

Use your user account when the assistant should work with your own chats: read groups and channels you are in, search your history, reply as you. Use a bot when you want a separate identity that people message on purpose, for example a support bot. Bots cannot read history from before they joined a chat and cannot start conversations.

### Can Telegram ban my account?

Telegram decides that, based on how an account behaves. telemcp keeps your sending close to normal use: a daily message cap, a smaller daily cap on new contacts, random pauses between new contacts and between sends, and a typing indicator. When Telegram answers with FLOOD_WAIT, telemcp waits the full time instead of retrying, and after PEER_FLOOD it stops messaging new people for the rest of the day. Messaging people who expect to hear from you is the best protection.

### Does it send my messages anywhere?

No. telemcp connects only to Telegram. Your messages are stored in a SQLite file on your machine and passed to the AI assistant you connected it to. There is no telemetry and no server of ours in between.

### Can it mass message?

No. There is no bulk send tool, each send has exactly one recipient, and the daily caps and pacing apply to every send.

### Does it read channels and groups?

Yes. With a user account it lists and reads every group, supergroup and channel you are a member of, and searches across them. A bot reads the groups it was added to, from the moment it joined.

### How do I log out?

Run `telemcp logout`, or ask the assistant to call `disconnect_telegram`. Both end the session on Telegram and delete the session file. You can also end it from Telegram itself under Settings, Devices. The local message database stays until you delete `~/.telemcp/telemcp.db`.

### Do I need my own api_id and api_hash?

Yes. Every telemcp install uses its owner's credentials from my.telegram.org. It takes about two minutes and keeps your usage separate from everyone else's.

## Limitations

* One Telegram account per server. Run a second server with another `TELEMCP_HOME` for a second account.
* `telegram_user_id` only works for users your account has already seen; use a username or a chat id from `list_chats` otherwise.
* Received media is described by its type; telemcp does not download media files.
* Secret chats are not supported (Telegram keeps them on the phone).
* Bots: no history before they joined, no global search, no read receipts.
* telemcp is not affiliated with, endorsed by or sponsored by Telegram.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a vulnerability.

Include what you found, how to reproduce it, and the telemcp version (`telemcp --version`). You will get a reply within a few days.

## What telemcp protects

* The Telegram session in `~/.telemcp/session` gives full access to your account. telemcp creates it, `config.json` and the database readable only by your user (mode 600). Never commit, share or paste these files.
* telemcp connects only to Telegram. It has no telemetry, update checks or other network calls.
* The HTTP mode listens on 127.0.0.1 only, rejects requests whose Host header is not local, and can require a bearer token (`--token`).
* Your api_id and api_hash are your own; telemcp ships no shared credentials.

If you think your session leaked, end it in Telegram under Settings, Devices, then run `telemcp login` again.

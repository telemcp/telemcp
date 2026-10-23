# Contributing

Thanks for helping. Bug reports, fixes and documentation improvements are all welcome.

## Setup

```bash
git clone https://github.com/telemcp/telemcp
cd telemcp
npm install
npm run typecheck
npm test
npm run build
node dist/cli.js --help
```

The tests run offline against a fake Telegram client (`test/fakes.ts`); they never touch the network.

## Ground rules

* **The tool surface is a contract.** Tool names, input fields and error codes come from `contract/door-contract.json` (door-contract 1.0) and are never renamed or removed within a major version. Add optional fields or new tools only; `test/tools.test.ts` checks the registered tools against the contract.
* **One recipient per send.** Pull requests that add bulk or broadcast sending will not be merged.
* **Only Telegram.** telemcp must not call any other server: no telemetry, analytics or update checks.
* **Safety limits stay simple** and readable in `src/limits.ts`.
* Logs go to stderr; stdout is reserved for the MCP stdio protocol.

## Pull requests

Keep changes focused, add or update tests, and describe what you changed and why. Note user visible changes in `CHANGELOG.md`.

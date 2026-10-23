// Minimal terminal prompts for `telemcp login`. Prompts go to stderr so stdout stays clean.

import { createInterface } from "node:readline";

export async function ask(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const out = rl as unknown as { _writeToOutput?: (s: string) => void; output: NodeJS.WritableStream };
  if (opts.hidden) {
    let prompted = false;
    out._writeToOutput = (s: string) => {
      if (!prompted) {
        process.stderr.write(s);
        prompted = true;
      } else if (s.includes("\n") || s.includes("\r")) process.stderr.write("\n");
    };
  }
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.question(question, (a) => resolve(a.trim()));
      rl.on("close", () => reject(new Error("input closed")));
    });
  } finally {
    rl.close();
  }
}

// src/secrets/Passphrase.ts
import { createInterface } from "readline";

export function isTtyAvailable(): boolean {
  return process.stdin.isTTY === true;
}

export async function promptPassphrase(opts?: {
  prompt?: string;
  confirm?: boolean;
}): Promise<string> {
  const passphrase = await readHidden(opts?.prompt ?? "Passphrase: ");

  if (opts?.confirm) {
    const confirmed = await readHidden("Confirm passphrase: ");
    if (passphrase !== confirmed) {
      throw new Error("Passphrases do not match.");
    }
  }

  return passphrase;
}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    process.stdout.write(prompt);

    // Disable echo by replacing _writeToOutput
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput =
      (_s: string) => {};

    rl.question("", (answer) => {
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });

    rl.on("SIGINT", () => {
      process.stdout.write("\n");
      rl.close();
      reject(new Error("Aborted by user (Ctrl+C)."));
    });
  });
}

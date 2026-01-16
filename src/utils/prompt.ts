import * as readline from "readline";

let rl: readline.Interface | null = null;

export function getReadlineInterface(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return rl;
}

export function prompt(question: string): Promise<string> {
  const readlineInterface = getReadlineInterface();
  return new Promise((resolve) => {
    readlineInterface.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

export function closeReadline(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}

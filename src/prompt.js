/** Tiny interactive yes/no prompt over a readline interface. */
import readline from 'node:readline';

/**
 * Ask a yes/no question. Resolves true only for y / yes (case-insensitive).
 * @param {string} question
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [opts]
 * @returns {Promise<boolean>}
 */
export function confirm(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

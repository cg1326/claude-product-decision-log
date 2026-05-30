import * as readline from 'readline';
import * as fs from 'fs';
import { ExtractedDecision } from './extract';

export async function reviewDecisions(decisions: ExtractedDecision[]): Promise<ExtractedDecision[]> {
  if (decisions.length === 0) {
    return [];
  }

  // Use /dev/tty directly so y/n input works even when stdin is a pipe (hook payload)
  const tty = fs.createReadStream('/dev/tty');
  const rl = readline.createInterface({
    input: tty,
    output: process.stdout,
    terminal: true,
  });

  const ask = (prompt: string): Promise<string> => {
    return new Promise(resolve => {
      rl.question(prompt, answer => {
        resolve(answer);
      });
    });
  };

  console.log(`\nFound ${decisions.length} decision${decisions.length === 1 ? '' : 's'} in this session. Review each:\n`);

  const kept: ExtractedDecision[] = [];

  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    console.log(`--- Decision ${i + 1}/${decisions.length} ---`);
    console.log(`Decision:   ${d.decision}`);
    console.log(`Considered: ${d.considered}`);
    console.log(`Rationale:  ${d.rationale}`);
    console.log(`Status:     ${d.status}`);

    const answer = await ask('Log this decision? (y/n): ');

    if (answer.trim().toLowerCase() === 'y') {
      kept.push(d);
    }

    console.log('');
  }

  rl.close();
  tty.destroy();
  return kept;
}

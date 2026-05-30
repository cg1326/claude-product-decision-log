import { extractDecisions } from '../extract';
import { reviewDecisions } from '../review';
import { saveDecisions, projectSlug } from '../storage';

interface StopPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
}

async function main(): Promise<void> {
  // Check for API key early
  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write('decision-log: ANTHROPIC_API_KEY is not set. Skipping decision extraction.\n');
    process.exit(0);
  }

  // Buffer all stdin before parsing
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawInput = Buffer.concat(chunks).toString('utf-8').trim();

  let payload: StopPayload;
  try {
    payload = JSON.parse(rawInput) as StopPayload;
  } catch {
    process.stderr.write('decision-log: Failed to parse hook payload from stdin\n');
    process.exit(0);
  }

  const { session_id, transcript_path, cwd } = payload;

  if (!transcript_path) {
    process.stderr.write('decision-log: No transcript_path in payload\n');
    process.exit(0);
  }

  // Step 1: Extract decisions from transcript
  let extracted;
  try {
    extracted = await extractDecisions(transcript_path);
  } catch (err) {
    process.stderr.write(`decision-log: Error extracting decisions: ${err}\n`);
    process.exit(0);
  }

  if (extracted.length === 0) {
    // No decisions found — exit silently
    process.exit(0);
  }

  // Step 2: Present decisions for review
  let confirmed;
  try {
    confirmed = await reviewDecisions(extracted);
  } catch (err) {
    process.stderr.write(`decision-log: Error during review: ${err}\n`);
    process.exit(0);
  }

  if (confirmed.length === 0) {
    // Nothing confirmed — exit silently
    process.exit(0);
  }

  // Step 3: Save confirmed decisions
  const slug = projectSlug(cwd);

  try {
    await saveDecisions(confirmed, session_id, cwd);
  } catch (err) {
    process.stderr.write(`decision-log: Error saving decisions: ${err}\n`);
    process.exit(0);
  }

  console.log(`Saved ${confirmed.length} decision${confirmed.length === 1 ? '' : 's'} to ${slug} log.`);

  process.exit(0);
}

main().catch(err => {
  process.stderr.write(`decision-log: Unexpected error: ${err}\n`);
  process.exit(0);
});

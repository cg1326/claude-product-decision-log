import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';

export interface ExtractedDecision {
  decision: string;
  considered: string;
  rationale: string;
  status: 'decided' | 'deferred' | 'reversed' | 'rejected';
}

const SYSTEM_PROMPT = `You are a product decision extractor. Read this Claude Code session transcript and identify genuine product or technical decisions made. Capture four types:

1. DECIDED — a direction was chosen over alternatives. Example: 'chose subscription pricing over one-time purchase because retention matters more than conversion rate.'
2. DEFERRED — something was explicitly pushed to later. Example: 'deferred live collaboration to v2 to reduce scope.'
3. REVERSED — a previous decision was changed. Example: 'switched from REST to GraphQL after the mobile client requirements became clear.'
4. REJECTED — an option was considered and permanently ruled out, with no code produced. This is the most important category to catch. Example: 'ruled out building a native app — web-only because the team has no mobile expertise and the use case doesn't require it.' These often appear as 'we decided not to...', 'we ruled out...', 'we won't be...', 'that's not worth...'.

Do NOT extract: pure implementation steps ('added a button'), debugging steps ('fixed the null pointer'), or passing comments with no reasoning attached.

For each genuine decision extract:
- decision: what was decided or ruled out (one sentence, active voice)
- considered: what alternatives were weighed (can be implicit)
- rationale: why this direction was chosen or rejected
- status: decided | deferred | reversed | rejected

Return a JSON array only. If no genuine decisions exist, return an empty array []. No other text.`;

function parseTranscript(content: string): string {
  const lines = content.split('\n').filter(line => line.trim() !== '');
  const messages: string[] = [];

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const role: string | undefined =
      entry?.message?.role ?? entry?.role;

    if (role !== 'user' && role !== 'assistant') {
      continue;
    }

    const messageContent = entry?.message?.content ?? entry?.content;
    if (!messageContent) continue;

    let text = '';
    if (typeof messageContent === 'string') {
      text = messageContent;
    } else if (Array.isArray(messageContent)) {
      for (const block of messageContent) {
        if (block?.type === 'text' && typeof block?.text === 'string') {
          text += block.text + ' ';
        }
        // Skip tool_use and tool_result blocks
      }
      text = text.trim();
    }

    if (text) {
      messages.push(`${role.toUpperCase()}: ${text}`);
    }
  }

  return messages.join('\n\n');
}

export async function extractDecisions(transcriptPath: string): Promise<ExtractedDecision[]> {
  // Check if file exists and is non-empty
  if (!transcriptPath) {
    return [];
  }

  let transcriptContent: string;
  try {
    if (!fs.existsSync(transcriptPath)) {
      return [];
    }
    transcriptContent = fs.readFileSync(transcriptPath, 'utf-8').trim();
    if (!transcriptContent) {
      return [];
    }
  } catch {
    return [];
  }

  const conversationText = parseTranscript(transcriptContent);
  if (!conversationText.trim()) {
    return [];
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    process.stderr.write('decision-log: ANTHROPIC_API_KEY is not set\n');
    return [];
  }

  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: 'Here is the Claude Code session transcript:\n\n' + conversationText,
        },
      ],
    });

    const firstBlock = response.content[0];
    if (!firstBlock || firstBlock.type !== 'text') {
      return [];
    }

    const rawText = firstBlock.text.trim();

    // Extract JSON array from response (handle potential markdown code fences)
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed as ExtractedDecision[];
  } catch (err) {
    process.stderr.write(`decision-log: API call failed: ${err}\n`);
    return [];
  }
}

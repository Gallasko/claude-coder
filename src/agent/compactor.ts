import Anthropic from '@anthropic-ai/sdk';
import { runHaikuTask, HaikuTaskResult } from './sdkBackend';

const COMPACT_SYSTEM =
  'Summarize this coding-agent transcript into a compact brief for continuing the same task. Include: the ' +
  'goal, key decisions made, files touched and what changed in each (be concrete: paths, function names), ' +
  'current state, and exactly what remains to be done. Terse — this replaces the full transcript, so omit ' +
  'anything the next step will not need. No preamble, no code blocks unless a snippet is essential.';

/** Characters of transcript fed to the summarizer, kept low to keep this call itself cheap. */
const MAX_TRANSCRIPT_CHARS = 40_000;

export type CompactResult = HaikuTaskResult & { summary: string };

/**
 * Local, cheap (Haiku, subscription-first with credits fallback) stand-in
 * for server-side compaction: collapse a growing transcript into one dense
 * summary instead of paying full price to resend it every turn. Never
 * mutates the session itself — the caller (controller.ts `compactIfNeeded`)
 * decides whether/how to replace the transcript with the summary.
 */
export async function compactTranscript(
  client: Anthropic | undefined,
  workspaceRoot: string | undefined,
  messages: Anthropic.MessageParam[],
  maxTokens: number
): Promise<CompactResult> {
  const transcript = flatten(messages).slice(-MAX_TRANSCRIPT_CHARS);
  const result = await runHaikuTask({
    client,
    workspaceRoot,
    maxTokens,
    system: COMPACT_SYSTEM,
    prompt: `Transcript so far:\n"""${transcript}"""`,
  });
  return { ...result, summary: result.text.trim() };
}

function flatten(messages: Anthropic.MessageParam[]): string {
  return messages.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : m.content.map(blockText).join(' ')}`).join('\n');
}

function blockText(b: any): string {
  switch (b.type) {
    case 'text':
      return b.text;
    case 'tool_use':
      return `[called ${b.name}(${JSON.stringify(b.input).slice(0, 150)})]`;
    case 'tool_result': {
      const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      return `[result: ${c.slice(0, 250)}]`;
    }
    default:
      return '';
  }
}

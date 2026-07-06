import Anthropic from '@anthropic-ai/sdk';

const COMPACT_SYSTEM =
  'Summarize this coding-agent transcript into a compact brief for continuing the same task. Include: the ' +
  'goal, key decisions made, files touched and what changed in each (be concrete: paths, function names), ' +
  'current state, and exactly what remains to be done. Terse — this replaces the full transcript, so omit ' +
  'anything the next step will not need. No preamble, no code blocks unless a snippet is essential.';

/** Characters of transcript fed to the summarizer, kept low to keep this call itself cheap. */
const MAX_TRANSCRIPT_CHARS = 40_000;

export interface CompactResult {
  summary: string;
  usage: Anthropic.Usage;
}

/**
 * Local, cheap (Haiku) stand-in for server-side compaction: collapse a
 * growing transcript into one dense summary instead of paying full price to
 * resend it every turn. Never mutates the session itself — the caller
 * (controller.ts `compactIfNeeded`) decides whether/how to replace the
 * transcript with the summary.
 */
export async function compactTranscript(
  client: Anthropic,
  model: string,
  messages: Anthropic.MessageParam[],
  maxTokens: number
): Promise<CompactResult> {
  const transcript = flatten(messages).slice(-MAX_TRANSCRIPT_CHARS);
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: COMPACT_SYSTEM,
    messages: [{ role: 'user', content: `Transcript so far:\n"""${transcript}"""` }],
  });
  const block = response.content.find((b) => b.type === 'text');
  return { summary: block && block.type === 'text' ? block.text.trim() : '', usage: response.usage };
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

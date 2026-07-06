import Anthropic from '@anthropic-ai/sdk';

const COMPRESS_SYSTEM =
  'Rewrite the following message to a coding agent. Keep every actionable requirement, exact file/function ' +
  'names, error text, and code block VERBATIM. Cut filler, repetition, and pleasantries. Do not add anything ' +
  'not present in the original, and do not answer or comment on it. Output only the rewritten message.';

export interface CompressResult {
  text: string;
  usage: Anthropic.Usage;
}

/**
 * Cheap (Haiku) pass that shrinks a long, prose-heavy user message before it
 * hits the expensive model — useful for pasted logs, specs, or rambling
 * instructions. Only worth calling above a size threshold (see
 * controller.ts); the caller must be prepared to fall back to the original
 * text if the result looks unsafe (e.g. suspiciously short).
 */
export async function compressPrompt(
  client: Anthropic,
  model: string,
  text: string,
  maxTokens: number
): Promise<CompressResult> {
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: COMPRESS_SYSTEM,
    messages: [{ role: 'user', content: text }],
  });
  const block = response.content.find((b) => b.type === 'text');
  return { text: block && block.type === 'text' ? block.text.trim() : text, usage: response.usage };
}

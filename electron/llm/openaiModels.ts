/**
 * Is `modelId` one of OpenAI's own model ids (bare, no routing prefix)?
 *
 * THE one predicate, for the same reason deepseekModels.ts has one: the
 * fetcher, providerFamily(), modelAvailable(), isCloudIdentifier() and
 * LLMHelper.isOpenAiModel() each carried their own prefix list, and they
 * drifted. The fetcher admitted bare `o3`, `o4-mini` and `chatgpt-4o-latest`,
 * the Settings list and the overlay picker showed them, and the dispatcher's
 * `gpt- | o1- | o3-` list sent none of them to OpenAI.
 *
 * Matches `gpt-*`, `chatgpt-*` and every o-series reasoner (`o1`, `o3`,
 * `o3-mini`, `o4-mini`, a future `o5`). Gateway ids (`openrouter/openai/...`,
 * `fluxion/gpt-...`, Groq's `openai/gpt-oss-...`) never match: each carries a
 * prefix, and callers that also accept `includes('openai')` exclude gateways
 * before asking.
 */
export function isOpenAiModelId(modelId: string | null | undefined): boolean {
    const id = (modelId || '').toLowerCase();
    return id.startsWith('gpt-') || id.startsWith('chatgpt-') || /^o\d/.test(id);
}

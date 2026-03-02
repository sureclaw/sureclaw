# Provider Lessons: LLM

### Async toAnthropicContent requires Promise.all for message arrays
**Date:** 2026-02-25
**Context:** Making toAnthropicContent() async to resolve image file references
**Lesson:** When converting a content mapping function from sync to async (e.g., to resolve file references), all callers that use `.map()` must be updated to `await Promise.all(messages.map(async ...))`. In the Anthropic provider, this means the `.chat()` method's message building loop needs Promise.all for both the message-level and content-block-level mapping.
**Tags:** async, anthropic, llm, images, promise-all

### Anthropic thinking deltas use 'thinking' key, not 'text'
**Date:** 2026-02-28
**Context:** Adding thinking/reasoning chunk support to the Anthropic LLM provider
**Lesson:** When processing Anthropic streaming events for extended thinking, the `content_block_delta` event's delta has a `thinking` key (not `text`). Cast delta to `Record<string, unknown>` to check for it since the SDK types may not include it yet. For OpenAI-compatible providers, reasoning content appears as `reasoning_content` or `reasoning` on the delta — also non-standard fields that need a cast to access.
**Tags:** anthropic, openai, thinking, reasoning, streaming, types

### OpenRouter image generation uses /chat/completions, not /images/generations
**Date:** 2026-02-26
**Context:** User got a 404 HTML page when generating images via OpenRouter. The `openai-images.ts` provider was hitting `/api/v1/images/generations`, which doesn't exist on OpenRouter.
**Lesson:** OpenRouter, Gemini, and OpenAI each use different endpoints and request/response formats for image generation. OpenRouter uses `/chat/completions` with `modalities: ["image", "text"]` and returns images in `message.images[].image_url.url` as data URLs. Don't assume all providers implement the same image generation API — check their docs. Each distinct API shape needs its own provider implementation.
**Tags:** openrouter, image-generation, api-endpoints, provider-differences

### Configure wizard must set config.model for non-claude-code agents
**Date:** 2026-02-22
**Context:** Users running `bun serve` after configure got "config.model is required for LLM router" because the wizard never prompted for a model
**Lesson:** The LLM router (used by pi-agent-core, pi-coding-agent) requires `config.model` as a compound `provider/model` ID (e.g. `anthropic/claude-sonnet-4-20250514`). Only claude-code agents bypass the router (they use the credential-injecting proxy). Any new agent type that uses the router must have model selection in the wizard.
**Tags:** onboarding, config, llm-router, configure

### API key env var naming follows ${PROVIDER.toUpperCase()}_API_KEY convention
**Date:** 2026-02-22
**Context:** The openai.ts provider uses `envKey()` to derive env var names dynamically from provider names
**Lesson:** When writing API keys to .env, use `${llmProvider.toUpperCase()}_API_KEY` (e.g. OPENROUTER_API_KEY, GROQ_API_KEY). The ANTHROPIC_API_KEY is the special case/default. This convention matches what the provider implementations expect at runtime.
**Tags:** onboarding, env, api-key, providers

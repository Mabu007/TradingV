/**
 * Live OpenRouter verification.
 *
 * The unit tests prove the request this code builds is the request the
 * documentation describes. They cannot prove what the network says. This
 * script does, against the real API, and it is deliberately separate from
 * `verify` because it needs the internet and — for the completion check —
 * a real key.
 *
 * What it establishes:
 *
 *   1. POST <chat url> reaches OpenRouter. Unauthenticated it answers 401,
 *      which is the point: a wrong path answers 404, so a 401 here is
 *      positive evidence that the URL is the endpoint and not a typo.
 *   2. GET <models url> returns the catalogue, and the shipped default
 *      model is in it. A default that is not listed is a default that
 *      404s on first use.
 *   3. With OPENROUTER_API_KEY set, a real completion comes back for the
 *      default model and for a second model, which is what proves key +
 *      model + endpoint together.
 *   4. A deliberately invalid model is reported as a model failure rather
 *      than being passed off as an endpoint problem.
 *
 * The key is read from the environment and never printed. Pass one to run
 * every check: `OPENROUTER_API_KEY=sk-or-v1-... bun src/adapters/openrouter/liveCheck.ts`
 */

import { chatCompletionsUrl, modelsUrl } from './endpoints';
import { classifyProviderFailure } from './errors';
import { DEFAULT_MODEL_ID, RECOMMENDED_MODEL_IDS, normaliseCatalogue } from './catalogue';

const apiKey = process.env.OPENROUTER_API_KEY?.trim() ?? '';

let failures = 0;

function report(ok: boolean, label: string, detail = ''): void {
  if (ok) {
    console.log(`ok    ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 1. The chat endpoint exists. */
async function checkChatEndpoint(): Promise<void> {
  const url = chatCompletionsUrl();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: DEFAULT_MODEL_ID, messages: [{ role: 'user', content: 'hey' }] }),
  });

  report(
    response.status === 401 || response.status === 402,
    'the chat endpoint resolves to an authenticated API',
    `${url} answered ${response.status}`,
  );
  report(
    response.status !== 404,
    'a 404 would mean the path is wrong, not that the key is missing',
  );
  await response.text().catch(() => '');
}

/** 2. The catalogue is reachable and the default model is in it. */
async function checkCatalogue(): Promise<string[]> {
  const response = await fetch(modelsUrl(), { headers: { Accept: 'application/json' } });
  report(response.ok, 'the model catalogue is public and reachable', `status ${response.status}`);
  if (!response.ok) return [];

  const payload: unknown = await response.json();
  const models = normaliseCatalogue(payload);
  report(models.length >= 30, 'the catalogue yields a usable number of text models', `${models.length} text models`);

  const ids = models.map((model) => model.id);
  report(
    ids.includes(DEFAULT_MODEL_ID),
    'the shipped default model is currently offered',
    DEFAULT_MODEL_ID,
  );
  report(
    RECOMMENDED_MODEL_IDS.filter((id) => ids.includes(id)).length >= 3,
    'at least three recommended models are currently offered',
    `${RECOMMENDED_MODEL_IDS.filter((id) => ids.includes(id)).length} of ${RECOMMENDED_MODEL_IDS.length}`,
  );
  return ids;
}

/** 3. A real completion, for the default model and one more. */
async function checkCompletions(ids: string[]): Promise<void> {
  if (!apiKey) {
    console.log('skip  live completion — set OPENROUTER_API_KEY to run it');
    return;
  }

  if (!/^sk-or-v1-[A-Za-z0-9_-]{16,}$/.test(apiKey)) {
    /*
     * A placeholder in .env is the common case and it fails as a 401 that
     * looks exactly like a real credential problem. Saying so here is the
     * difference between a five-minute fix and an afternoon.
     */
    console.log('skip  live completion — OPENROUTER_API_KEY does not look like a real OpenRouter key');
    return;
  }

  const targets = [DEFAULT_MODEL_ID, ...ids.filter((id) => id !== DEFAULT_MODEL_ID && id.endsWith(':free'))].slice(0, 2);

  for (const model of targets) {
    try {
      const response = await fetch(chatCompletionsUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
          max_tokens: 32,
        }),
      });

      const body = await response.text();
      if (!response.ok) {
        const error = classifyProviderFailure(response.status, body, model);
        report(false, `model ${model} answered`, `${error.code} (status ${response.status})`);
        continue;
      }

      const parsed: unknown = JSON.parse(body);
      const content = (parsed as { choices?: Array<{ message?: { content?: string } }> })
        ?.choices?.[0]?.message?.content;
      report(
        typeof content === 'string' && content.trim().length > 0,
        `model ${model} answered`,
        JSON.stringify(content).slice(0, 60),
      );
    } catch (error) {
      report(false, `model ${model} answered`, error instanceof Error ? error.message : 'unknown error');
    }
  }
}

/** 4. A bad model is reported as a bad model. */
async function checkBadModel(): Promise<void> {
  if (!apiKey || !/^sk-or-v1-[A-Za-z0-9_-]{16,}$/.test(apiKey)) {
    console.log('skip  invalid-model check — needs a real OPENROUTER_API_KEY');
    return;
  }

  const response = await fetch(chatCompletionsUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'inclusionai/ling-3.0-flash-fin:free',
      messages: [{ role: 'user', content: 'hey' }],
      max_tokens: 16,
    }),
  });

  const body = await response.text().catch(() => '');
  const error = classifyProviderFailure(response.status, body, 'inclusionai/ling-3.0-flash-fin:free');
  report(
    !response.ok && (error.code === 'MODEL_NOT_FOUND' || error.code === 'MODEL_UNAVAILABLE'),
    'the retired model is classified as a model failure, not an endpoint failure',
    error.code,
  );
}

const ids = await checkCatalogue();
await checkChatEndpoint();
await checkCompletions(ids);
await checkBadModel();

console.log(failures === 0 ? '\nLive OpenRouter verification passed.' : `\n${failures} live check(s) failed.`);
if (failures > 0) process.exit(1);

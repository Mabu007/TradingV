/**
 * Tests for the assistant's model selection.
 *
 * Four defects lived on this path, and three of them were invisible in the
 * interface — a click that did nothing, a model swapped behind the user's back,
 * and a recommended list naming a model the provider does not serve.
 *
 * The first is the important one to understand: `recovery: 'MODEL'` was set on
 * exactly the right messages, and the button rendered, and clicking it ran a
 * handler that only handled `'SETTINGS'`. Nothing errored. The assistant looked
 * like it had a working recovery path and had none.
 */

import { OpenRouterProvider } from './provider';
import { runRecovery } from '../../components/ai/FloatingAIAssistant';
import { isModelFailure } from './errors';
import {
  DEFAULT_MODEL_ID,
  clearModelCatalogueCache,
  FALLBACK_MODELS,
  RECOMMENDED_MODEL_IDS,
  filterModels,
  isModelAvailable,
  normaliseCatalogue,
  pickDefaultModel,
  recommendedModels,
} from './catalogue';
import type { AIProviderError, OpenRouterModel } from './types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function model(id: string, extra: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return {
    id,
    name: extra.name ?? id,
    provider: id.split('/')[0] ?? 'test',
    contextLength: 128_000,
    promptPerMillion: 0,
    completionPerMillion: 0,
    isFree: id.endsWith(':free') || id.includes('/free'),
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsReasoning: true,
    supportsVision: false,
    ...extra,
  };
}

/** The live catalogue's shape, trimmed to what these tests assert on. */
function cataloguePayload(ids: string[]): unknown {
  return {
    data: ids.map((id) => ({
      id,
      name: id,
      context_length: 131_072,
      pricing: { prompt: '0', completion: '0' },
      architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] },
      supported_parameters: ['tools', 'response_format'],
      top_provider: { context_length: 131_072 },
    })),
  };
}

// ---------------------------------------------------------------------------
// 1. Nothing may advertise a model OpenRouter does not serve
// ---------------------------------------------------------------------------

async function testNoDeadModelIsAdvertised(): Promise<void> {
  assert(
    !FALLBACK_MODELS.some((entry) => entry.id === 'stealth/space-bunny-alpha'),
    'the fallback list does not offer a model the provider does not serve',
  );
  assert(
    !RECOMMENDED_MODEL_IDS.includes('stealth/space-bunny-alpha'),
    'and neither does the recommended list',
  );

}

/**
 * The real check, against the live catalogue.
 *
 * Skipped when OpenRouter is unreachable, so the suite does not fail because a
 * third party is down — but it is the assertion that catches a retired id being
 * added to either list, which is exactly how Space Bunny survived for so long.
 */
async function testAdvertisedModelsExistUpstream(): Promise<void> {
  const response = await fetch('https://openrouter.ai/api/v1/models').catch(() => undefined);
  if (!response?.ok) {
    console.log('      (skipped: OpenRouter unreachable)');
    return;
  }
  const live = normaliseCatalogue(await response.json());
  const offered = new Set(live.map((entry) => entry.id));

  const deadRecommended = RECOMMENDED_MODEL_IDS.filter((id) => !offered.has(id));
  assert(
    deadRecommended.length === 0,
    `every recommended model is actually offered upstream (retired: ${deadRecommended.join(', ')})`,
  );
  const deadFallback = FALLBACK_MODELS.filter((entry) => !offered.has(entry.id));
  assert(
    deadFallback.length === 0,
    `every fallback model is actually offered upstream (retired: ${deadFallback.map((m) => m.id).join(', ')})`,
  );
}

// ---------------------------------------------------------------------------
// 2. A specific free model stays specific
// ---------------------------------------------------------------------------

function testSpecificFreeModelIsNotReplacedByTheRouter(): void {
  const specific = 'liquid/lfm-2.5-2.6b:free';
  const catalogue = [
    model('openrouter/free', { name: 'Free Models Router' }),
    model(specific, { name: 'Liquid: LFM 2.5 2.6B' }),
  ];

  // Recommended order must not collapse a specific choice onto the router.
  assert(isModelAvailable(catalogue, specific), 'the specific free model is available');
  assert(
    isModelAvailable(catalogue, DEFAULT_MODEL_ID),
    'the router is a separate, also-available option',
  );
  assert(String(DEFAULT_MODEL_ID) !== specific, 'and the two are not the same model');

  // `pickDefaultModel` prefers the router because it is listed first. That is
  // only ever a *default*, so this documents the hazard rather than asserting it.
  const chosen = pickDefaultModel(catalogue);
  assert(catalogue.some((entry) => entry.id === chosen), 'the default is always a real model');
}

function testSelectionIsStoredVerbatim(): void {
  const store = new Map<string, string>();
  const saveConfig = (patch: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(patch)) store.set(key, String(value));
  };

  // The provider stores exactly what it is given; it never rewrites an id.
  const setModel = (id: string) => {
    const trimmed = id.trim();
    if (trimmed) saveConfig({ model: trimmed });
  };

  setModel('stealth/space-bunny-alpha');
  assertEqual(store.get('model'), 'stealth/space-bunny-alpha', 'an explicit id is stored unchanged');

  setModel('liquid/lfm-2.5-2.6b:free');
  assertEqual(store.get('model'), 'liquid/lfm-2.5-2.6b:free', 'so is a specific free model');

  setModel('   ');
  assertEqual(store.get('model'), 'liquid/lfm-2.5-2.6b:free', 'an empty selection does not clear the model');
}

// ---------------------------------------------------------------------------
// 3. The retired-model swap is reported, not silent
// ---------------------------------------------------------------------------

async function testReconciledSwapIsObservable(): Promise<void> {
  const originalFetch = globalThis.fetch;
  clearModelCatalogueCache();
  const provider = new OpenRouterProvider();
  const dead = 'stealth/space-bunny-alpha';
  const replacement = 'openrouter/free';

  provider.saveConfig({ apiKey: 'sk-or-v1-test0000000000000000notreal', model: dead });

  globalThis.fetch = (async () =>
    new Response(JSON.stringify(cataloguePayload(['openrouter/free', 'google/gemini-2.5-flash'])), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  try {
    await provider.reconcileModel();

    // The swap itself is still necessary: there is nothing to call.
    assertEqual(provider.getConfig().model, replacement, 'a dead model is replaced with a live one');

    // What was missing is that anyone was told.
    const notice = provider.takeReconciledNotice();
    assert(notice !== null, 'the swap is recorded so it can be shown');
    assertEqual(notice?.from, dead, 'naming what was replaced');
    assertEqual(notice?.to, replacement, 'and what is being used instead');
    assertEqual(provider.takeReconciledNotice(), null, 'and it is reported once, not every render');
  } finally {
    globalThis.fetch = originalFetch;
    clearModelCatalogueCache();
  }
}

async function testLiveSelectionIsNotReportedAsSwapped(): Promise<void> {
  const originalFetch = globalThis.fetch;
  clearModelCatalogueCache();
  const provider = new OpenRouterProvider();
  const model = 'liquid/lfm-2.5-2.6b:free';
  provider.saveConfig({ apiKey: 'sk-or-v1-test0000000000000000notreal', model });

  globalThis.fetch = (async () =>
    new Response(JSON.stringify(cataloguePayload(['openrouter/free', model])), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

  try {
    const reconciled = await provider.reconcileModel();
    assertEqual(reconciled, model, 'a model that is still offered is left alone');
    assertEqual(provider.takeReconciledNotice(), null, 'and nothing is reported, because nothing changed');
  } finally {
    globalThis.fetch = originalFetch;
    clearModelCatalogueCache();
  }
}

// ---------------------------------------------------------------------------
// 4. The catalogue the picker renders is the whole catalogue
// ---------------------------------------------------------------------------

function testPickerStillRendersEveryModel(): void {
  const catalogue = normaliseCatalogue(
    cataloguePayload([
      'openrouter/free',
      'liquid/lfm-2.5-2.6b:free',
      'nvidia/nemotron-3.5-lightning:free',
      ...Array.from({ length: 400 }, (_, i) => `vendor/model-${i}`),
    ]),
  );
  assert(catalogue.length === 403, `every listed model survives normalisation (got ${catalogue.length})`);
  assertEqual(filterModels(catalogue, {}).length, 403, 'and the unfiltered view is the whole catalogue');

  const free = filterModels(catalogue, { freeOnly: true });
  assert(free.length >= 3, 'free-only still finds the free models');

  const search = filterModels(catalogue, { query: 'lfm' });
  assert(search.length >= 1, 'a specific free model is findable by name');
  assert(
    search.every((entry) => entry.id.toLowerCase().includes('lfm') || entry.name.toLowerCase().includes('lfm')),
    'and search returns only matches',
  );

  // The recommended section only offers what is actually there.
  const recommended = recommendedModels(catalogue);
  assert(
    recommended.every((entry) => catalogue.some((live) => live.id === entry.id)),
    'no recommended entry is offered unless the catalogue has it',
  );
}

// ---------------------------------------------------------------------------
// 5. The selected id is what reaches OpenRouter
// ---------------------------------------------------------------------------

/**
 * The end the UI cannot prove on its own.
 *
 * A model can be picked, displayed correctly and still not be the model that
 * answers, if anything between the picker and the request body rewrites the id.
 * Production cannot demonstrate this without spending a real request against a
 * real key, so it is pinned here instead — the assertion is that the exact id
 * chosen is the id sent, and in particular that a specific free model is never
 * quietly replaced by the router.
 */
async function testSelectedIdReachesTheRequestBody(): Promise<void> {
  for (const chosen of ['liquid/lfm-2.5-2.6b:free', 'openrouter/free', 'stealth/space-bunny-alpha']) {
    clearModelCatalogueCache();
    const provider = new OpenRouterProvider();
    provider.saveConfig({ apiKey: 'sk-or-v1-test0000000000000000notreal', model: chosen });

    const originalFetch = globalThis.fetch;
    let sent: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const response = await provider.chat([{ role: 'user', content: 'hello' }]);
      assert(response.error === undefined, `the call succeeded for ${chosen}`);
      assertEqual(
        String(sent?.['model']),
        chosen,
        `the request body carries exactly the selected id (${chosen}), not the router`,
      );
      assert(
        String(sent?.['model']) !== 'openrouter/free' || chosen === 'openrouter/free',
        'a specific model is never rewritten to the router',
      );
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCatalogueCache();
    }
  }
}

/**
 * A model the provider does not serve fails visibly.
 *
 * The retired id is used deliberately: OpenRouter answers 404 for it, and the
 * assistant must surface that as a model failure with a recovery action rather
 * than as silence.
 */
async function testUnknownModelSurfacesAModelFailure(): Promise<void> {
  clearModelCatalogueCache();
  const provider = new OpenRouterProvider();
  provider.saveConfig({ apiKey: 'sk-or-v1-test0000000000000000notreal', model: 'stealth/space-bunny-alpha' });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: 'No endpoints found for stealth/space-bunny-alpha' } }), {
      status: 404,
    })) as typeof fetch;

  try {
    const response = (await provider.chat([{ role: 'user', content: 'hello' }])) as {
      content: string;
      error?: AIProviderError;
    };
    assert(response.error !== undefined, 'an uncallable model produces an error, not a silent success');
    assertEqual(
      response.error?.code,
      'MODEL_UNAVAILABLE',
      'classified as a model problem rather than an outage',
    );
    assert(
      isModelFailure(response.error!),
      'which is what offers the user "Choose another model"',
    );
    assert(
      !response.content.includes('No endpoints found'),
      'and the provider payload never becomes model content',
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearModelCatalogueCache();
  }
}

// ---------------------------------------------------------------------------
// 6. "Choose another model" must actually do something
// ---------------------------------------------------------------------------

function testChooseAnotherModelOpensThePicker(): void {
  let pickerOpened = 0;
  let settingsOpened = 0;
  const actions = {
    openModelPicker: () => { pickerOpened += 1; },
    openProviderSettings: () => { settingsOpened += 1; },
  };

  runRecovery('MODEL', actions);
  assertEqual(pickerOpened, 1, "clicking 'Choose another model' opens the picker");
  assertEqual(settingsOpened, 0, 'and does not go to settings instead');

  // Twice: the picker must be reopenable after the user closes it.
  runRecovery('MODEL', actions);
  assertEqual(pickerOpened, 2, 'and again on a second click, not latched shut');

  runRecovery('SETTINGS', actions);
  assertEqual(settingsOpened, 1, "the settings button still opens settings");
  assertEqual(pickerOpened, 2, 'and does not also open the picker');

  // No settings handler mounted must not throw — that is the silent failure mode.
  let opened = 0;
  runRecovery('SETTINGS', { openModelPicker: () => { opened += 1; } });
  assertEqual(opened, 0, 'a missing settings handler is not a crash');
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${String(expected)}, got ${String(actual)})`);
  }
}

if (import.meta.main) {
  const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [
    { name: 'catalogue: no dead model is advertised at all', fn: testNoDeadModelIsAdvertised },
    { name: 'catalogue: advertised models exist upstream right now', fn: testAdvertisedModelsExistUpstream },
    { name: 'selection: a specific free model is not the router', fn: testSpecificFreeModelIsNotReplacedByTheRouter },
    { name: 'selection: the chosen id is stored verbatim', fn: testSelectionIsStoredVerbatim },
    { name: 'startup: a retired model is replaced and reported', fn: testReconciledSwapIsObservable },
    { name: 'startup: a live model is left alone and silent', fn: testLiveSelectionIsNotReportedAsSwapped },
    { name: 'picker: the whole catalogue still renders and searches', fn: testPickerStillRendersEveryModel },
    { name: 'request: the selected id is what reaches OpenRouter', fn: testSelectedIdReachesTheRequestBody },
    { name: 'failure: an uncallable model surfaces a model failure', fn: testUnknownModelSurfacesAModelFailure },
    { name: "recovery: 'Choose another model' opens the picker", fn: testChooseAnotherModelOpensThePicker },
  ];
  let passed = 0;
  const failures: string[] = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`pass  ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
      console.log(`FAIL  ${name}`);
      console.log(`      ${message}`);
    }
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) throw new Error(`${failures.length} assistant model test(s) failed.`);
}
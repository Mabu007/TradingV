/**
 * Tests for the model picker's list composition.
 *
 * The picker had a filter in its render that kept only the recommended ids
 * while labelling the section "All text models (466)". A 466-model catalogue
 * became 8 rows, and a search matching 96 became 1. The adapter, the
 * normalisation and `filterModels` were all correct the whole time — the loss
 * happened between the filtered list and the rendered rows.
 *
 * That gap survived the existing suite because every OpenRouter test asserts on
 * the functions *underneath* the picker and none of them rendered it. These
 * tests cover the composition step itself: given a catalogue and a set of
 * matches, which rows does the list owe the user.
 *
 * No DOM harness is introduced. The sectioning is pure, so it is tested as
 * pure, using the same runner style as the rest of the repository.
 */

import { sectionModelRows } from './ModelPicker';
import { RECOMMENDED_MODEL_IDS, filterModels, recommendedModels } from '../../adapters/openrouter/catalogue';
import type { OpenRouterModel } from '../../adapters/openrouter/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** The smallest model that survives `filterModels` with no filters set. */
function model(id: string, name = id): OpenRouterModel {
  return {
    id,
    name,
    provider: id.split('/')[0] ?? 'test',
    contextLength: 128_000,
    promptPerMillion: 1,
    completionPerMillion: 2,
    isFree: false,
    supportsTools: true,
    supportsStructuredOutputs: true,
    supportsReasoning: false,
    supportsVision: false,
    description: 'Test model.',
  };
}

/** Builds `count` filler models that share no id with a recommended model. */
function filler(count: number, prefix = 'vendor/model'): OpenRouterModel[] {
  return Array.from({ length: count }, (_, index) => model(`${prefix}-${index}`));
}

const ids = (models: OpenRouterModel[]): string[] => models.map((entry) => entry.id);

/**
 * Test 1 — the full catalogue reaches the list.
 *
 * The regression in one assertion: with no search, every non-recommended model
 * is rendered. Before the fix this returned only the recommended ids, so a
 * catalogue of ~500 produced 8 rows.
 *
 * The total is derived rather than written down: the recommended list changes
 * when a model is retired upstream, and a hardcoded count then fails for a
 * reason that has nothing to do with the picker.
 */
function runFullCatalogueTest(): void {
  const recommendedFixtures = RECOMMENDED_MODEL_IDS.map((id) => model(id));
  const others = filler(492);
  const catalogue = [...recommendedFixtures, ...others];
  const expectedTotal = catalogue.length;

  const matches = filterModels(catalogue, {});
  const recommended = recommendedModels(catalogue);
  const { all } = sectionModelRows(matches, recommended, true);

  assert(matches.length === expectedTotal, 'the filters keep the whole catalogue');
  assert(recommended.length > 0, 'the catalogue yields a recommended section');
  assert(
    all.length === matches.length - recommended.length,
    'the All section holds every model that is not recommended',
  );
  assert(
    all.length > 400,
    `the All section must not collapse to the recommended set (got ${all.length})`,
  );

  const seen = new Set([...ids(recommended), ...ids(all)]);
  assert(seen.size === catalogue.length, 'recommended plus All covers the catalogue exactly');
}

/**
 * Test 2 — a search result set is not thinned.
 *
 * The reported symptom was a search for "gpt" matching 96 models showing one.
 * The All section used to keep only recommended ids from those 96. A fixture
 * of 96 proves the same thing without 96 hand-written models: what matters is
 * that non-recommended matches survive.
 */
function runSearchTest(): void {
  const matches = filler(96, 'openai/gpt');
  const recommended = filler(3, 'openai/gpt');

  // A search hides the Recommended heading, so recommendedVisible is false and
  // every match belongs to All — otherwise they would vanish between lists.
  const { all } = sectionModelRows(matches, recommended, false);

  assert(all.length === 96, `a 96-result search renders all 96 (got ${all.length})`);
  assert(
    all.some((entry) => !recommended.some((pick) => pick.id === entry.id)),
    'non-recommended matches are not discarded for not being recommended',
  );
}

/**
 * Test 2b — the same search with the Recommended heading still on screen.
 *
 * Deduplication must not become deletion: a recommended model that matched is
 * still shown, just once, under Recommended.
 */
function runSearchKeepsRecommendedOnceTest(): void {
  const match = model('vendor/one');
  const pick = model(RECOMMENDED_MODEL_IDS[0]);
  const recommended = [pick];

  const { all } = sectionModelRows([pick, match], recommended, true);

  assert(all.length === 1 && all[0].id === match.id, 'the recommended match moves out of All');
  assert(ids(recommended).includes(pick.id), 'the recommended match is still rendered, once');
}

/**
 * Test 3 — no model appears in both sections.
 */
function runNoDuplicatesTest(): void {
  const recommended = RECOMMENDED_MODEL_IDS.map((id) => model(id));
  const matches = [...recommended, ...filler(40)];

  const { all } = sectionModelRows(matches, recommended, true);
  const recommendedSet = new Set(ids(recommended));
  const overlap = ids(all).filter((id) => recommendedSet.has(id));

  assert(overlap.length === 0, `no id is rendered twice (overlap: ${overlap.join(', ')})`);
  assert(all.length === 40, 'every non-recommended model still renders');
}

/**
 * Test 4 — a catalogue with nothing recommended still renders in full.
 *
 * A fallback or stale catalogue may contain no recommended ids at all. If the
 * section were filtered by recommended membership it would collapse to zero
 * rows and read as "no models".
 */
function runUnrecommendedCatalogueTest(): void {
  const matches = filler(30);
  const recommended = recommendedModels(matches);

  assert(recommended.length === 0, 'no model in this catalogue is recommended');
  const { all } = sectionModelRows(matches, recommended, true);

  assert(all.length === 30, `every model renders (got ${all.length})`);
}

/**
 * Test 5 — the fallback catalogue is small on purpose and must stay usable.
 *
 * The built-in list legitimately holds only the recommended set. It must still
 * render, and it must not be confused with a live catalogue: the picker states
 * the source separately, so sectioning has no reason to hide anything.
 */
function runFallbackCatalogueTest(): void {
  const catalogue = RECOMMENDED_MODEL_IDS.map((id) => model(id));
  const matches = filterModels(catalogue, {});
  const recommended = recommendedModels(catalogue);

  assert(matches.length === recommended.length, 'the fallback list is the recommended set');

  const { all } = sectionModelRows(matches, recommended, true);
  assert(all.length === 0, 'nothing is left over for the All section, which is then hidden');

  const { all: everything } = sectionModelRows(matches, recommended, false);
  assert(everything.length === matches.length, 'with no Recommended heading, all matches render');
}

if (import.meta.main) {
  runFullCatalogueTest();
  runSearchTest();
  runSearchKeepsRecommendedOnceTest();
  runNoDuplicatesTest();
  runUnrecommendedCatalogueTest();
  runFallbackCatalogueTest();
  console.log('ModelPicker catalogue sectioning tests passed.');
}

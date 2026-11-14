import { artifactTypes } from '@agentic-seo/artifacts';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modelErrorText, runTestCase } from '../src/prompts';
import { fakeLlm } from '../src/testing';

// #885 round 6: a failed AI call stores its error in `ai_calls.error`, and a test run shows it as a
// problem. A provider error can echo a credential, so the text is redacted while it is complete,
// then cut. Ported from Agentic Marketing 9a7a5721 (packages/ai/test/ai-error-text.test.ts).

const SECRET = 'probe-secret';

describe('AI call failure text (#885)', () => {
  it('redacts a credential in a model error', () => {
    const text = modelErrorText(new Error(`provider refused: password=${SECRET}`));
    expect(text).toContain('model_error:');
    expect(text).toContain('provider refused');
    expect(text).not.toContain(SECRET);
  });

  it('redacts before cutting a long provider error', () => {
    const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
    const text = modelErrorText(new Error(`refused: ${' '.repeat(470)}${token}`));
    expect(text).not.toContain('a1b2c3d4e5f60718');
    expect(text.length).toBeLessThanOrEqual(520);
  });
});

describe('a prompt test case whose model call fails (#885)', () => {
  const generate = artifactTypes.prompt.content.parse({
    title: 'Write a title',
    instructions: 'Write.',
    output: {
      kind: 'text',
      slots: [{ name: 'title', description: 'A title', maxLength: 30, fallback: 'News from us' }],
    },
    tests: [{ name: 'probe', input: { topic: 'pricing' } }],
  });
  let llm: Awaited<ReturnType<typeof fakeLlm>>;

  beforeAll(async () => {
    llm = await fakeLlm(() => ({ status: 500, error: `provider refused: password=${SECRET}` }));
  });
  afterAll(() => llm.close());

  it('reports the failure as a problem without the credential', async () => {
    const model = {
      providerId: 'aip_x',
      modelId: 'm',
      model: createOpenAICompatible({ name: 't', baseURL: llm.baseUrl, apiKey: 'k', supportsStructuredOutputs: true })('m'),
    };
    const test = generate.tests[0];
    if (!test) throw new Error('the prompt should have a test case');
    const r = await runTestCase(model, generate, test);
    const problems = r.problems.join(' ');
    expect(problems).toContain('model call failed');
    expect(problems).not.toContain(SECRET);
  });
});

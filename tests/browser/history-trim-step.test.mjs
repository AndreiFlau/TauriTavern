// Personal v2.4.0 build only: the same checks as tests/webview/history-trim-step.test.mjs on dev,
// written for v2.4.0's node:test browser runtime.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserRuntime } from './runtime.mjs';

test('history trim step', async (context) => {
    const { window, getModule, load, startHost } = await createBrowserRuntime();

    try {
        await startHost();
        await load('script.js');
        const openai = getModule('scripts/openai.js').namespace;
        const { macros, initRegisterMacros } = getModule('scripts/macros/macro-system.js').namespace;
        initRegisterMacros();
        const ajax = window.jQuery.ajax;
        // 3 per message: the counter subtracts 2, so each message costs one token.
        window.jQuery.ajax = options => options.url?.startsWith('/api/tokenizers/openai/count-batch')
            ? Promise.resolve({ token_counts: JSON.parse(options.data).map(() => 3) })
            : ajax(options);

        const EXAMPLE_DIALOGUES = [[{ content: 'example a' }], [{ content: 'example b' }], [{ content: 'example c' }]];

        async function assemble(chatLength, historyTrimStep) {
            const settings = openai.normalizeChatCompletionSettingsForPromptAssembly({
                chat_completion_source: 'moonshot', moonshot_model: 'kimi-k3',
                openai_max_context: 96, openai_max_tokens: 16, history_trim_step: historyTrimStep,
            });
            settings.prompt_order = [{
                character_id: 100001,
                order: ['main', 'dialogueExamples', 'chatHistory'].map(identifier => ({ identifier, enabled: true })),
            }];
            const chat = Array.from({ length: chatLength }, (_, number) => ({
                role: number % 2 ? 'assistant' : 'user', content: `message ${number}`, sourceCount: 1,
            }));
            const { messages } = await openai.assembleOpenAIChatCompletionPrompt({
                settings, macroContext: macros.captureContext(), agentMode: false, generationType: 'normal',
                promptInputs: { messages: chat.reverse(), messageExamples: EXAMPLE_DIALOGUES, extensionPrompts: {} },
            });
            // Copied into this realm: the runtime's arrays have another Array prototype, which strict deepEqual rejects.
            const texts = Array.from(messages, message => String(message.content));
            return {
                history: texts.filter(text => text.startsWith('message ')).map(text => Number(text.slice('message '.length))),
                examples: texts.filter(text => text.startsWith('example ')),
            };
        }

        const CHAT_LENGTHS = Array.from({ length: 40 }, (_, offset) => 200 + offset);

        await context.test('without a step, the start of the history moves with every new message', async () => {
            const starts = [];
            for (const length of CHAT_LENGTHS) {
                const { history } = await assemble(length, 0);
                assert.equal(history.at(-1), length - 1);
                assert.ok(history.length < length);
                starts.push(history[0]);
            }
            assert.equal(new Set(starts).size, CHAT_LENGTHS.length);
        });

        await context.test('with a step, the history starts on a multiple of the step and stays there', async () => {
            const step = 10;
            const starts = [];
            for (const length of CHAT_LENGTHS) {
                const natural = (await assemble(length, 0)).history;
                const { history } = await assemble(length, step);
                assert.equal(history.at(-1), length - 1);
                assert.deepEqual(history, Array.from({ length: history.length }, (_, offset) => history[0] + offset));
                assert.equal(history[0] % step, 0);
                assert.ok(history[0] >= natural[0] && history[0] - natural[0] < step);
                starts.push(history[0]);
            }
            assert.ok(new Set(starts).size <= Math.ceil(CHAT_LENGTHS.length / step) + 1);
        });

        await context.test('the space a step frees is not handed to dialogue examples', async () => {
            for (const length of CHAT_LENGTHS) {
                assert.deepEqual((await assemble(length, 10)).examples, (await assemble(length, 0)).examples);
            }
        });

        await context.test('a chat that fits the context is sent whole', async () => {
            const { history } = await assemble(12, 10);
            assert.deepEqual(history, Array.from({ length: 12 }, (_, number) => number));
        });
    } finally {
        await window.happyDOM.close();
    }
});

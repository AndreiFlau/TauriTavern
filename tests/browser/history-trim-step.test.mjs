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
        const { power_user } = getModule('scripts/power-user.js').namespace;
        const { macros, initRegisterMacros } = getModule('scripts/macros/macro-system.js').namespace;
        const { createMacroContextFromSnapshot, updateFrozenMacroContext } = await import(
            new URL('../../src/scripts/tauritavern/agent/frozen-run-input-snapshot.js', import.meta.url).href);
        initRegisterMacros();
        const ajax = window.jQuery.ajax;
        // 3 per message: the counter subtracts 2, so each message costs one token.
        window.jQuery.ajax = options => options.url?.startsWith('/api/tokenizers/openai/count-batch')
            ? Promise.resolve({ token_counts: JSON.parse(options.data).map(() => 3) })
            : ajax(options);

        const EXAMPLE_DIALOGUES = [[{ content: 'example a' }], [{ content: 'example b' }], [{ content: 'example c' }]];

        // Captures the generation context with the step set in User Settings; left out, the saved default.
        function captureWithStep(historyTrimStep) {
            const saved = power_user.history_trim_step;
            if (historyTrimStep !== undefined) {
                power_user.history_trim_step = historyTrimStep;
            }
            try {
                return macros.captureContext();
            } finally {
                power_user.history_trim_step = saved;
            }
        }

        // The context of an Agent Run saved before History Trim Step existed.
        function rebuildRunSavedBeforeTheStep() {
            const snapshot = updateFrozenMacroContext({}, macros.captureContext());
            delete snapshot.macroContext.settings.history_trim_step;
            return createMacroContextFromSnapshot(snapshot, { extensionPrompts: {} });
        }

        // A note depth injects a one-token note; empty numbers are chat messages left empty, which are never sent.
        async function assemble(chatLength, historyTrimStep, noteDepth, emptyNumbers = [], macroContext = captureWithStep(historyTrimStep)) {
            const settings = openai.normalizeChatCompletionSettingsForPromptAssembly({
                chat_completion_source: 'moonshot', moonshot_model: 'kimi-k3',
                openai_max_context: 96, openai_max_tokens: 16,
            });
            const order = ['main', 'dialogueExamples', 'chatHistory'];
            if (noteDepth !== undefined) {
                settings.prompts.push({
                    identifier: 'note', name: 'Note', system_prompt: false, role: 'system', content: 'note',
                    injection_position: 1, injection_depth: noteDepth, injection_order: 100,
                });
                order.push('note');
            }
            settings.prompt_order = [{
                character_id: 100001,
                order: order.map(identifier => ({ identifier, enabled: true })),
            }];
            const chat = Array.from({ length: chatLength }, (_, number) => ({
                role: number % 2 ? 'assistant' : 'user', content: emptyNumbers.includes(number) ? '' : `message ${number}`, sourceCount: 1,
            }));
            const { messages } = await openai.assembleOpenAIChatCompletionPrompt({
                settings, macroContext, agentMode: false, generationType: 'normal',
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

        await context.test('User Settings without a saved step trim in steps of 20', async () => {
            for (const length of CHAT_LENGTHS) {
                assert.deepEqual((await assemble(length)).history, (await assemble(length, 20)).history);
            }
        });

        await context.test('an Agent Run saved before the step existed is rebuilt trimmed one message at a time', async () => {
            for (const length of CHAT_LENGTHS) {
                const { history } = await assemble(length, undefined, undefined, [], rebuildRunSavedBeforeTheStep());
                assert.deepEqual(history, (await assemble(length, 0)).history);
            }
        });

        await context.test('a note injected where the budget runs out does not empty the history', async () => {
            const length = 230;
            const fits = (await assemble(length, 0)).history.length;
            for (let depth = fits - 3; depth <= fits + 1; depth += 1) {
                const natural = (await assemble(length, 0, depth)).history;
                const { history } = await assemble(length, 20, depth);
                assert.ok(history.length > 0);
                assert.equal(history.at(-1), length - 1);
                assert.deepEqual(history, Array.from({ length: history.length }, (_, offset) => history[0] + offset));
                assert.ok(history[0] % 20 === 0 || history[0] === natural[0]);
            }
        });

        await context.test('a chat that fits the context is sent whole', async () => {
            const { history } = await assemble(12, 10);
            assert.deepEqual(history, Array.from({ length: 12 }, (_, number) => number));
        });

        await context.test('an empty newest message does not let the step empty the history', async () => {
            const length = 201;
            const { history } = await assemble(length, 100, undefined, [length - 1]);
            assert.ok(history.length > 0);
            assert.equal(history.at(-1), length - 2);
        });

        await context.test('an invalid step stops assembly even when the chat fits the context', async () => {
            for (const step of [1.5, -1, '20']) {
                await assert.rejects(assemble(12, step), /prompt_assembly\.history_trim_step_invalid/);
            }
        });
    } finally {
        await window.happyDOM.close();
    }
});

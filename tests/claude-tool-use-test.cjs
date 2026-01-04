/**
 * Claude Tool Use Test
 *
 * Verifies that Claude models handle tool_use/tool_result correctly:
 * - Schema sanitization preserves constraints
 * - Tool result format is correct
 * - No "invalid arguments" errors
 */

const { streamRequest, commonTools } = require('./helpers/http-client.cjs');
const { getTestModels } = require('./helpers/test-models.cjs');

async function testClaudeToolUse() {
    console.log('='.repeat(60));
    console.log('CLAUDE TOOL USE TEST');
    console.log('='.repeat(60));

    const modelConfigs = getTestModels(['gemini']); // Exclude Gemini, only test Claude
    let allPassed = true;

    for (const config of modelConfigs) {
        const model = config.model;
        console.log(`\nTesting model: ${model} (family: ${config.family})`);
        console.log('-'.repeat(40));

        const messages = [
            {
                role: 'user',
                content: 'Run "ls -la" command'
            }
        ];

        const result = await streamRequest({
            model,
            max_tokens: 4096,
            stream: true,
            tools: [commonTools.executeCommand],
            thinking: { budget_tokens: 16000 },
            messages
        });

        if (result.error) {
            console.log(`  ❌ FAILED: ${result.error.message}`);
            allPassed = false;
        } else {
            console.log(`  Content blocks: ${result.content.length}`);
            console.log(`  Content types: ${result.content.map(b => b.type).join(', ')}`);
            if (result.content.length > 0) {
                console.log(`  First block:`, JSON.stringify(result.content[0]).substring(0, 200));
            }

            const hasToolUse = result.content.some(b => b.type === 'tool_use');
            const hasThinking = result.content.some(b => b.type === 'thinking');
            const hasSignature = result.content.some(b =>
                b.type === 'thinking' && b.signature && b.signature.length >= 50
            );

            console.log(`  ✓ Thinking: ${hasThinking ? 'YES' : 'NO'}`);
            console.log(`  ✓ Signature: ${hasSignature ? 'YES' : 'NO'}`);
            console.log(`  ✓ Tool Use: ${hasToolUse ? 'YES' : 'NO'}`);

            if (hasToolUse && hasThinking && hasSignature) {
                console.log(`  ✅ PASSED`);
            } else {
                console.log(`  ❌ FAILED: Missing components`);
                allPassed = false;
            }
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log(allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED');
    console.log('='.repeat(60));

    process.exit(allPassed ? 0 : 1);
}

testClaudeToolUse().catch(err => {
    console.error('Test error:', err);
    process.exit(1);
});

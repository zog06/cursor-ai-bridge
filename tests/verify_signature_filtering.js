
import { restoreThinkingSignatures } from '../src/format/thinking-utils.js';
import { MIN_SIGNATURE_LENGTH } from '../src/constants.js';

console.log(`MIN_SIGNATURE_LENGTH: ${MIN_SIGNATURE_LENGTH}`);

// This is the signature used in src/format/response-converter.js
const SYNTHETIC_SIGNATURE = 'gemini-synthetic-thinking-for-tool-use-to-prevent-looping';
console.log(`SYNTHETIC_SIGNATURE length: ${SYNTHETIC_SIGNATURE.length}`);

// Test content block with synthetic signature
const content = [
    {
        type: 'thinking',
        thinking: 'Analyzing the request...',
        signature: SYNTHETIC_SIGNATURE
    }
];

console.log('Testing restoreThinkingSignatures with synthetic signature...');
const filtered = restoreThinkingSignatures(content);

console.log(`Filtered result length: ${filtered.length}`);

if (filtered.length === 0) {
    console.log('[FAIL] Synthetic signature was dropped! valid filtering caused this.');
    process.exit(1);
} else {
    console.log('[PASS] Synthetic signature was preserved.');
}


import { logDebugFile } from './src/utils/logger.js';

console.log('Testing logger...');
try {
    logDebugFile('test', '001', { message: 'Hello World' });
    console.log('Logger test completed.');
} catch (error) {
    console.error('Logger test failed:', error);
}

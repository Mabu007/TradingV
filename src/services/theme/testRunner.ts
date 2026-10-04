import { runThemeTests } from './tests';
import { runAIContextTests } from '../aiContext/tests';

runThemeTests();
runAIContextTests();
console.log('Theme and AI application-context tests passed.');

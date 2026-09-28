import { ITradingEnvironment } from '../types';

export function createLiveEnvironment(): ITradingEnvironment {
  throw new Error('LIVE agent execution is not available until an explicitly confirmed production environment adapter is implemented.');
}

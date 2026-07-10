import { PRICING } from './agent/models';

/**
 * How a task chooses between the subscription backend (Claude Code / Agent SDK,
 * billed to the user's Pro/Max plan) and the credits backend (direct API key).
 */
export type BackendPreference = 'subscriptionOnly' | 'apiOnly' | 'preferSubscription' | 'preferApi';

export const DEFAULT_BACKEND_PREFERENCE: BackendPreference = 'preferSubscription';

/** Model ids known to the extension's pricing table. */
export const AVAILABLE_MODELS: string[] = Object.keys(PRICING);

/** Which backend a task should start on, given what's actually configured. Undefined = nothing usable. */
export function backendForPreference(
  pref: BackendPreference,
  hasSubscription: boolean,
  hasApiKey: boolean
): 'subscription' | 'credits' | undefined {
  switch (pref) {
    case 'subscriptionOnly':
      return hasSubscription ? 'subscription' : undefined;
    case 'apiOnly':
      return hasApiKey ? 'credits' : undefined;
    case 'preferSubscription':
      return hasSubscription ? 'subscription' : hasApiKey ? 'credits' : undefined;
    case 'preferApi':
      return hasApiKey ? 'credits' : hasSubscription ? 'subscription' : undefined;
  }
}

/** Whether a task on this preference may fall back to the other backend mid-task. */
export function allowsFallback(pref: BackendPreference): boolean {
  return pref === 'preferSubscription' || pref === 'preferApi';
}

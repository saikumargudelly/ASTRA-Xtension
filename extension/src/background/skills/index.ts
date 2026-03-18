// ════════════════════════════════════════════════════════════════════════════
// ASTRA Skills Index
// ─ Wire point: call registerAllSkills(deps) once from browser-actions.ts
//   after helpers are initialised. All skills are populated into the singleton
//   skillRegistry, which dispatchPlannerAction() uses for routing.
//
// HOW TO ADD A NEW ACTION TYPE:
//   1. Add a new entry to buildBrowserSkills() (browser-skills.ts) or
//      buildDOMSkills() (dom-skills.ts) depending on action category.
//   2. Also add the name string to ALLOWED_BROWSER_ACTIONS or
//      ALLOWED_DOM_ACTIONS in security.ts so the security guard permits it.
//   3. Add it to the LLM system prompt in pageIntelligence.ts if the model
//      needs to know it exists (optional but recommended).
//   That's it — no touching of browser-actions.ts, dispatchPlannerAction,
//   or any other routing code.
// ════════════════════════════════════════════════════════════════════════════

export { skillRegistry } from './registry.js';
export type { Skill, SkillResult, SkillExecutor, BrowserContext } from './registry.js';

import { skillRegistry } from './registry.js';
import { buildBrowserSkills } from './browser-skills.js';
import { buildDOMSkills } from './dom-skills.js';
import type { BrowserSkillDeps } from './browser-skills.js';
import type { DOMSkillDeps } from './dom-skills.js';

export type AllSkillDeps = BrowserSkillDeps & DOMSkillDeps;

let registered = false;

/**
 * Populate the skillRegistry with all browser and DOM skills.
 * Called once from browser-actions.ts after helper functions are defined.
 * Idempotent — safe to call multiple times (subsequent calls are no-ops).
 */
export function registerAllSkills(deps: AllSkillDeps): void {
    if (registered) return;
    registered = true;

    skillRegistry.registerAll(buildBrowserSkills(deps));
    skillRegistry.registerAll(buildDOMSkills(deps));

    console.log(
        `[ASTRA|Skills] Registered ${skillRegistry.listNames().length} skills`,
        `(browser: ${skillRegistry.listBrowserNames().length},`,
        `dom: ${skillRegistry.listDOMNames().length})`,
    );
}

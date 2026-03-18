// ════════════════════════════════════════════════════════════════════════════
// ASTRA SkillRegistry
// ─ Single source of truth for every action type ASTRA can perform.
// ─ Adding a new action means: add one Skill entry and register it —
//   nothing else needs to change anywhere in the codebase.
//
// Pattern:
//   1. Import skillRegistry
//   2. skillRegistry.register({ name, type, description, execute })
//   3. dispatchPlannerAction() will route to it automatically
// ════════════════════════════════════════════════════════════════════════════

import type { PlannerAction, TabInfo } from '../../types/messages.js';

// ─── Browser Context (only what skills need) ──────────────────────────────────
export interface BrowserContext {
    tabs: TabInfo[];
    activeTabId: number | null;
    activeTab: TabInfo | null;
    windowIds: number[];
}

export type SkillResult = { success: boolean; data?: unknown; error?: string };

export type SkillExecutor = (
    action: PlannerAction,
    ctx: BrowserContext,
    /** tabId — provided only for DOM skills */
    tabId?: number,
    /** tabUrl — provided only for DOM skills */
    tabUrl?: string,
) => Promise<SkillResult>;

export interface Skill {
    /** Matches action.type exactly (e.g. 'click', 'navigate') */
    name: string;
    /** 'browser' → uses chrome.tabs/windows APIs. 'dom' → injected into page via content script. */
    type: 'browser' | 'dom';
    /**
     * One-line description injected into the LLM system prompt so the model
     * knows this action exists and when to use it.
     */
    description: string;
    execute: SkillExecutor;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export class SkillRegistry {
    private readonly skills = new Map<string, Skill>();

    /** Register a single skill. Throws if name already registered (catches typos). */
    register(skill: Skill): void {
        if (this.skills.has(skill.name)) {
            throw new Error(`[SkillRegistry] Duplicate skill name: "${skill.name}"`);
        }
        this.skills.set(skill.name, skill);
    }

    /** Register multiple skills at once. */
    registerAll(skills: Skill[]): void {
        for (const skill of skills) this.register(skill);
    }

    get(name: string): Skill | undefined {
        return this.skills.get(name);
    }

    has(name: string): boolean {
        return this.skills.has(name);
    }

    isBrowserSkill(name: string): boolean {
        return this.skills.get(name)?.type === 'browser';
    }

    isDOMSkill(name: string): boolean {
        return this.skills.get(name)?.type === 'dom';
    }

    /** All registered action type names — plugs straight into the security allowlist. */
    listNames(): string[] {
        return [...this.skills.keys()];
    }

    /** All browser-level action names. */
    listBrowserNames(): string[] {
        return [...this.skills.values()].filter(s => s.type === 'browser').map(s => s.name);
    }

    /** All DOM-level action names. */
    listDOMNames(): string[] {
        return [...this.skills.values()].filter(s => s.type === 'dom').map(s => s.name);
    }

    /**
     * Returns a formatted skill catalogue for injection into LLM system prompts.
     * Keeps the model aware of the full action surface without hardcoding it
     * in every prompt template.
     */
    describeAll(type?: 'browser' | 'dom'): string {
        const entries = [...this.skills.values()];
        const filtered = type ? entries.filter(s => s.type === type) : entries;
        const browser = filtered.filter(s => s.type === 'browser');
        const dom = filtered.filter(s => s.type === 'dom');
        const lines: string[] = [];
        if (browser.length) {
            lines.push('BROWSER ACTIONS (tab/window management):');
            browser.forEach(s => lines.push(`  ${s.name}: ${s.description}`));
        }
        if (dom.length) {
            lines.push('DOM ACTIONS (interact with page elements):');
            dom.forEach(s => lines.push(`  ${s.name}: ${s.description}`));
        }
        return lines.join('\n');
    }
}

/** Singleton used throughout the extension. */
export const skillRegistry = new SkillRegistry();

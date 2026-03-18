// ════════════════════════════════════════════════════════════════════════════
// ASTRA Browser Skills
// ─ All chrome.tabs / chrome.windows actions.
// ─ Each skill is self-contained: name, type = 'browser', LLM description,
//   and execute() function.
// ─ To add a new browser action: append a new entry to the array returned by
//   buildBrowserSkills(). Nothing else needs to change.
// ════════════════════════════════════════════════════════════════════════════

import type { Skill, SkillResult, BrowserContext } from './registry.js';
import type { PlannerAction } from '../../types/messages.js';

export interface BrowserSkillDeps {
    validateUrl: (url: string) => { allowed: boolean; reason?: string };
    waitForTabLoad: (tabId: number, timeoutMs?: number) => Promise<void>;
    /** Event-driven two-phase idle detection. Prefer over waitForTabLoad after navigations. */
    waitForNetworkIdle: (tabId: number, options?: { idleTimeout?: number; maxWait?: number }) => Promise<void>;
    sleep: (ms: number) => Promise<void>;
    captureScreenshot: (tabId?: number) => Promise<string | null>;
}

type BAction = PlannerAction;

export function buildBrowserSkills(deps: BrowserSkillDeps): Skill[] {
    const { validateUrl, waitForTabLoad, waitForNetworkIdle, sleep, captureScreenshot } = deps;

    return [
        // ── Tab creation ──────────────────────────────────────────────────
        {
            name: 'open_tab',
            type: 'browser',
            description: 'Open a URL in a new foreground tab and wait for it to load.',
            async execute(action: BAction, _ctx: BrowserContext): Promise<SkillResult> {
                const url = (action as { url: string }).url;
                const check = validateUrl(url);
                if (!check.allowed) return { success: false, error: check.reason };
                const tab = await chrome.tabs.create({ url, active: true });
                await waitForNetworkIdle(tab.id!, { idleTimeout: 500, maxWait: 15_000 });
                return { success: true, data: { tabId: tab.id } };
            },
        },
        {
            name: 'new_tab',
            type: 'browser',
            description: 'Alias for open_tab — opens a URL in a new tab.',
            async execute(action: BAction, _ctx: BrowserContext): Promise<SkillResult> {
                const url = (action as { url: string }).url;
                const check = validateUrl(url);
                if (!check.allowed) return { success: false, error: check.reason };
                const tab = await chrome.tabs.create({ url, active: true });
                await waitForNetworkIdle(tab.id!, { idleTimeout: 500, maxWait: 15_000 });
                return { success: true, data: { tabId: tab.id } };
            },
        },

        // ── Tab lifecycle ──────────────────────────────────────────────────
        {
            name: 'close_tab',
            type: 'browser',
            description: 'Close a tab by tabId (defaults to the currently active tab).',
            async execute(action: BAction, ctx: BrowserContext): Promise<SkillResult> {
                const tabId = (action as { tabId?: number }).tabId ?? ctx.activeTabId;
                if (!tabId) return { success: false, error: 'No tab to close' };
                await chrome.tabs.remove(tabId);
                return { success: true };
            },
        },
        {
            name: 'switch_tab',
            type: 'browser',
            description: 'Bring a tab to the foreground by its tabId.',
            async execute(action: BAction, _ctx: BrowserContext): Promise<SkillResult> {
                const { tabId } = action as { tabId: number };
                await chrome.tabs.update(tabId, { active: true });
                const tab = await chrome.tabs.get(tabId);
                await chrome.windows.update(tab.windowId, { focused: true });
                return { success: true };
            },
        },
        {
            name: 'reload_tab',
            type: 'browser',
            description: 'Reload the active tab (or a specific tabId). Pass bypassCache:true for hard reload.',
            async execute(action: BAction, ctx: BrowserContext): Promise<SkillResult> {
                const a = action as { tabId?: number; bypassCache?: boolean };
                const tabId = a.tabId ?? ctx.activeTabId;
                if (!tabId) return { success: false, error: 'No tab to reload' };
                await chrome.tabs.reload(tabId, { bypassCache: !!a.bypassCache });
                await waitForNetworkIdle(tabId, { idleTimeout: 500, maxWait: 15_000 });
                return { success: true };
            },
        },
        {
            name: 'duplicate_tab',
            type: 'browser',
            description: 'Duplicate the active tab (or a specific tabId).',
            async execute(action: BAction, ctx: BrowserContext): Promise<SkillResult> {
                const tabId = (action as { tabId?: number }).tabId ?? ctx.activeTabId;
                if (!tabId) return { success: false, error: 'No tab to duplicate' };
                const dup = await chrome.tabs.duplicate(tabId);
                return { success: true, data: { tabId: dup?.id } };
            },
        },
        {
            name: 'pin_tab',
            type: 'browser',
            description: 'Pin or unpin a tab. Provide pinned:true or pinned:false.',
            async execute(action: BAction, ctx: BrowserContext): Promise<SkillResult> {
                const a = action as { tabId?: number; pinned: boolean };
                const tabId = a.tabId ?? ctx.activeTabId;
                if (!tabId) return { success: false, error: 'No tab to pin' };
                await chrome.tabs.update(tabId, { pinned: a.pinned });
                return { success: true };
            },
        },
        {
            name: 'mute_tab',
            type: 'browser',
            description: 'Mute or unmute a tab. Provide muted:true or muted:false.',
            async execute(action: BAction, ctx: BrowserContext): Promise<SkillResult> {
                const a = action as { tabId?: number; muted: boolean };
                const tabId = a.tabId ?? ctx.activeTabId;
                if (!tabId) return { success: false, error: 'No tab to mute' };
                await chrome.tabs.update(tabId, { muted: a.muted });
                return { success: true };
            },
        },
        {
            name: 'move_tab',
            type: 'browser',
            description: 'Move a tab to a new index position in its window.',
            async execute(action: BAction, _ctx: BrowserContext): Promise<SkillResult> {
                const { tabId, index } = action as { tabId: number; index: number };
                await chrome.tabs.move(tabId, { index });
                return { success: true };
            },
        },
        {
            name: 'zoom_tab',
            type: 'browser',
            description: 'Set page zoom level (factor: 1.0 = 100%, 1.5 = 150%).',
            async execute(action: BAction, ctx: BrowserContext): Promise<SkillResult> {
                const a = action as { tabId?: number; factor: number };
                const tabId = a.tabId ?? ctx.activeTabId;
                if (!tabId) return { success: false, error: 'No tab for zoom' };
                await chrome.tabs.setZoom(tabId, a.factor);
                return { success: true };
            },
        },

        // ── Navigation ─────────────────────────────────────────────────────
        {
            name: 'navigate',
            type: 'browser',
            description: 'Navigate the active tab (or tabId) to a URL and wait for page load.',
            async execute(action: BAction, ctx: BrowserContext): Promise<SkillResult> {
                const a = action as { url: string; tabId?: number };
                const check = validateUrl(a.url);
                if (!check.allowed) return { success: false, error: check.reason };
                const tabId = a.tabId ?? ctx.activeTabId;
                if (!tabId) return { success: false, error: 'No active tab to navigate' };
                await chrome.tabs.update(tabId, { url: a.url });
                await waitForNetworkIdle(tabId, { idleTimeout: 500, maxWait: 15_000 });
                return { success: true };
            },
        },
        {
            name: 'go_back',
            type: 'browser',
            description: 'Navigate the active tab one step back in browser history.',
            async execute(action: BAction, ctx: BrowserContext): Promise<SkillResult> {
                const tabId = (action as { tabId?: number }).tabId ?? ctx.activeTabId;
                if (!tabId) return { success: false, error: 'No active tab' };
                await chrome.tabs.goBack(tabId);
                await sleep(1500);
                return { success: true };
            },
        },
        {
            name: 'go_forward',
            type: 'browser',
            description: 'Navigate the active tab one step forward in browser history.',
            async execute(action: BAction, ctx: BrowserContext): Promise<SkillResult> {
                const tabId = (action as { tabId?: number }).tabId ?? ctx.activeTabId;
                if (!tabId) return { success: false, error: 'No active tab' };
                await chrome.tabs.goForward(tabId);
                await sleep(1500);
                return { success: true };
            },
        },

        // ── Window management ──────────────────────────────────────────────
        {
            name: 'new_window',
            type: 'browser',
            description: 'Open a new browser window, optionally in incognito mode with a starting URL.',
            async execute(action: BAction, _ctx: BrowserContext): Promise<SkillResult> {
                const a = action as { url?: string; incognito?: boolean };
                if (a.url) {
                    const check = validateUrl(a.url);
                    if (!check.allowed) return { success: false, error: check.reason };
                }
                const win = await chrome.windows.create({ url: a.url, incognito: !!a.incognito, focused: true });
                return { success: true, data: { windowId: win.id } };
            },
        },
        {
            name: 'close_window',
            type: 'browser',
            description: 'Close a specific window (windowId) or the current window.',
            async execute(action: BAction, _ctx: BrowserContext): Promise<SkillResult> {
                const windowId = (action as { windowId?: number }).windowId;
                if (windowId) {
                    await chrome.windows.remove(windowId);
                } else {
                    const cur = await chrome.windows.getCurrent();
                    await chrome.windows.remove(cur.id!);
                }
                return { success: true };
            },
        },
        {
            name: 'focus_window',
            type: 'browser',
            description: 'Bring a specific window to the foreground by windowId.',
            async execute(action: BAction, _ctx: BrowserContext): Promise<SkillResult> {
                const { windowId } = action as { windowId: number };
                await chrome.windows.update(windowId, { focused: true });
                return { success: true };
            },
        },

        // ── Tab queries ────────────────────────────────────────────────────
        {
            name: 'get_all_tabs',
            type: 'browser',
            description: 'Return a list of all currently open tabs with their IDs, titles, and URLs.',
            async execute(_action: BAction, ctx: BrowserContext): Promise<SkillResult> {
                return { success: true, data: ctx.tabs };
            },
        },
        {
            name: 'search_tabs',
            type: 'browser',
            description: 'Find open tabs whose title or URL contains a query string.',
            async execute(action: BAction, ctx: BrowserContext): Promise<SkillResult> {
                const { query } = action as { query: string };
                const q = query.toLowerCase();
                const matched = ctx.tabs.filter(
                    t => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)
                );
                return { success: true, data: matched };
            },
        },

        // ── Utilities ──────────────────────────────────────────────────────
        {
            name: 'screenshot',
            type: 'browser',
            description: 'Capture a JPEG screenshot of the active tab (or a specific tabId). Returns dataUrl.',
            async execute(action: BAction, _ctx: BrowserContext): Promise<SkillResult> {
                const img = await captureScreenshot((action as { tabId?: number }).tabId);
                return { success: true, data: { dataUrl: img } };
            },
        },
        {
            name: 'bookmark_page',
            type: 'browser',
            description: 'Bookmark the current page (or a specific URL/title).',
            async execute(action: BAction, ctx: BrowserContext): Promise<SkillResult> {
                const a = action as { title?: string; url?: string };
                const tab = ctx.activeTab;
                const bookmark = await chrome.bookmarks.create({
                    title: a.title ?? tab?.title ?? 'Bookmark',
                    url: a.url ?? tab?.url,
                });
                return { success: true, data: { bookmarkId: bookmark.id } };
            },
        },
        {
            name: 'download_file',
            type: 'browser',
            description: 'Download a file from a URL. Optionally specify a filename.',
            async execute(action: BAction, _ctx: BrowserContext): Promise<SkillResult> {
                const a = action as { url: string; filename?: string };
                const check = validateUrl(a.url);
                if (!check.allowed) return { success: false, error: check.reason };
                const dlId = await chrome.downloads.download({ url: a.url, filename: a.filename, saveAs: false });
                return { success: true, data: { downloadId: dlId } };
            },
        },
    ] satisfies Skill[];
}

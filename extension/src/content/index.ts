import type {
    ExecuteDOMActionMessage,
    ReadDOMMessage,
    AnalyzePageMessage,
    DOMElement,
    PageAnalysisData,
    PageMeta,
    PageSection,
    PageLink,
    PageForm,
    PageTable,
    PageImage,
    ViewportSnapshot,
} from '../types/messages';

// ─── Message Listener ───
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'EXECUTE_DOM_ACTION') {
        handleDOMAction(message as ExecuteDOMActionMessage)
            .then((result) => sendResponse(result))
            .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.type === 'READ_DOM') {
        showScanningOverlay(); // Visual feedback
        const data = readDOM(message as ReadDOMMessage);
        setTimeout(hideScanningOverlay, 500); // Brief flash for quick read
        sendResponse(data);
        return true;
    }

    if (message.type === 'ANALYZE_PAGE') {
        analyzePage(message as AnalyzePageMessage)
            .then((data) => sendResponse({ success: true, data }))
            .catch((err) => {
                hideScanningOverlay();
                sendResponse({ success: false, error: err.message });
            });
        return true;
    }

    // ─── FIND_ELEMENT: Vision-assisted smart element finder ───
    // Given a description like "search input" or "main nav button", find the best matching element
    if (message.type === 'FIND_ELEMENT') {
        const { description, elementType } = message.payload || {};
        const found = findElementByDescription(description, elementType);
        sendResponse({ success: !!found, selector: found ?? null });
        return true;
    }

    // ─── HIGHLIGHT_RESULTS: On-page visual ASTRA badges for ranked results ───
    if (message.type === 'HIGHLIGHT_RESULTS') {
        const { results, query } = message.payload || {};
        highlightResultsOnPage(results, query);
        sendResponse({ success: true });
        return true;
    }

    // ─── DISCOVER_FILTERS: Find all filter/sort UI elements on the page ───
    if (message.type === 'DISCOVER_FILTERS') {
        const filters = discoverPageFilters();
        sendResponse({ success: true, data: filters });
        return true;
    }

    // ─── CLICK_ELEMENT: Click a specific element by selector with cursor animation ───
    if (message.type === 'CLICK_ELEMENT') {
        const { selector, label } = message.payload || {};
        const el = document.querySelector(selector) as HTMLElement;
        if (!el) {
            sendResponse({ success: false, error: `Element not found: ${selector}` });
            return true;
        }
        (async () => {
            await cursorFocusElement(el, label || 'Applying filter...');
            cursorClick();
            el.click();
            await sleep(300);
            hideCursorFeedback();
            setTimeout(() => removeAstraCursor(), 800);
            sendResponse({ success: true });
        })();
        return true;
    }
});

// ─── Filter/Sort Discovery System ───
// Scans the page for all interactive filter/sort elements
// Works across Udemy, Amazon, YouTube, eBay, Coursera, LinkedIn, etc.
function discoverPageFilters(): Array<{
    type: string;
    label: string;
    selector: string;
    currentValue?: string;
    options?: string[];
}> {
    const filters: Array<{
        type: string; label: string; selector: string;
        currentValue?: string; options?: string[];
    }> = [];
    const seenLabels = new Set<string>();

    const addFilter = (f: typeof filters[0]) => {
        // Use composite key so different selectors for the same text (e.g. nested checkbox in label) are kept
        const key = f.label.toLowerCase().trim() + '|' + f.selector;
        if (f.label.length < 2 || seenLabels.has(key)) return;
        seenLabels.add(key);
        filters.push(f);
    };

    // Build a unique selector for any element
    const generateSelector = (el: HTMLElement): string => {
        if (el.id) return `#${CSS.escape(el.id)}`;
        if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
        if (el.getAttribute('data-purpose')) return `[data-purpose="${el.getAttribute('data-purpose')}"]`;
        if (el.getAttribute('name')) return `${el.tagName.toLowerCase()}[name="${el.getAttribute('name')}"]`;
        if (el.getAttribute('aria-label')) return `[aria-label="${CSS.escape(el.getAttribute('aria-label')!)}"]`;
        // Use href for links
        if (el.tagName === 'A' && el.getAttribute('href')) {
            const href = el.getAttribute('href')!;
            if (href.length < 120) return `a[href="${CSS.escape(href)}"]`;
        }
        // nth-of-type approach for class-based selectors
        const classes = Array.from(el.classList).filter(c => c.length < 50 && !c.match(/^[a-f0-9]{6,}$/)).slice(0, 2).join('.');
        if (classes) {
            const tag = el.tagName.toLowerCase();
            const parent = el.parentElement;
            if (parent) {
                const siblings = Array.from(parent.querySelectorAll(`:scope > ${tag}.${classes.split('.')[0]}`));
                const idx = siblings.indexOf(el);
                if (siblings.length === 1) return `${tag}.${classes}`;
                if (idx >= 0) return `${tag}.${classes}:nth-of-type(${idx + 1})`;
            }
            return `${tag}.${classes}`;
        }
        return '';
    };

    // Broad keywords for filter/sort detection across websites
    const filterKeywords = /\b(sort|filter|rating|duration|level|price|topic|category|date|language|popular|newest|oldest|relevant|best|hour|hours|all time|this week|this month|this year|today|free|paid|beginner|intermediate|advanced|expert|reviews|stars|enrollment|enroll|delivery|shipping|brand|department|size|color|condition|seller|prime|subscribe|featured|low.to.high|high.to.low|avg|average|customer|ascending|descending|most.recent|top.rated|best.seller|best.match|recommended|new.arrival|video.duration|upload.date|view.count|subcategor|results|refine|narrow|apply|clear.all|show.more|show.less)\b/i;
    const ignoreKeywords = /out of 5|stars?/i;

    // 1. Standard <select> dropdowns
    document.querySelectorAll('select').forEach(sel => {
        if (!isVisible(sel as HTMLElement)) return;
        const label = sel.getAttribute('aria-label') || sel.name ||
            (sel.previousElementSibling?.textContent?.trim()) ||
            (sel.closest('label')?.textContent?.trim()) || '';
        const options = Array.from(sel.options).map(o => o.text.trim()).filter(Boolean);
        const selector = generateSelector(sel as HTMLElement);
        if (selector) {
            addFilter({
                type: 'dropdown',
                label: label || 'Sort/Filter dropdown',
                selector,
                currentValue: sel.options[sel.selectedIndex]?.text?.trim(),
                options: options.slice(0, 15),
            });
        }
    });

    // 2. Custom dropdown triggers (React/Vue/Angular style)
    // Look for div/button/span that act as dropdown triggers
    document.querySelectorAll('[role="listbox"], [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="true"], [aria-expanded]').forEach(el => {
        if (!isVisible(el as HTMLElement)) return;
        const text = (el.textContent || '').trim();
        if (text.length < 2 || text.length > 80 || ignoreKeywords.test(text)) return;
        const selector = generateSelector(el as HTMLElement);
        if (selector) {
            addFilter({
                type: 'custom-dropdown',
                label: text.substring(0, 50),
                selector,
                currentValue: el.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed',
            });
        }
    });

    // 3. Filter sidebar sections — find panels with filter/sidebar/facet classes
    // This catches Amazon's left sidebar, Udemy's filter panel, etc.
    const filterPanelSelectors = [
        '[class*="filter" i]', '[class*="sidebar" i]', '[class*="facet" i]',
        '[class*="refinement" i]', '[class*="narrow" i]', '[id*="filter" i]',
        '[id*="sidebar" i]', '[id*="facet" i]', '[data-component-type="s-refinements"]',
        'aside', 'nav[aria-label*="filter" i]', '[role="navigation"][aria-label*="filter" i]',
    ];
    const filterPanels = document.querySelectorAll(filterPanelSelectors.join(', '));
    filterPanels.forEach(panel => {
        if (!isVisible(panel as HTMLElement)) return;
        // Extract clickable items inside filter panels
        panel.querySelectorAll('a, button, [role="button"], label, [role="checkbox"], [role="radio"], [role="option"]').forEach(item => {
            if (!isVisible(item as HTMLElement)) return;
            const text = (item.textContent || '').trim();
            if (text.length < 2 || text.length > 70 || ignoreKeywords.test(text)) return;
            // Skip nav/menu items that aren't filters
            if (text.match(/^(home|about|contact|sign|log|cart|account|help|support)$/i)) return;
            const selector = generateSelector(item as HTMLElement);
            if (selector) {
                const isActive = item.getAttribute('aria-selected') === 'true' ||
                    item.getAttribute('aria-checked') === 'true' ||
                    item.classList.contains('active') ||
                    item.classList.contains('selected') ||
                    item.classList.contains('checked');
                addFilter({
                    type: 'sidebar-filter',
                    label: text.substring(0, 50),
                    selector,
                    currentValue: isActive ? 'active' : undefined,
                });
            }
        });
    });

    // 4. Sort/filter buttons and links with keyword matching
    document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="option"], [role="menuitem"]').forEach(el => {
        if (!isVisible(el as HTMLElement)) return;
        const text = (el.textContent || '').trim();
        if (text.length < 2 || text.length > 60 || ignoreKeywords.test(text)) return;
        if (!filterKeywords.test(text) && !filterKeywords.test(el.getAttribute('aria-label') || '')) return;
        // Skip if already captured in sidebar
        const inSidebar = el.closest('[class*="filter" i], [class*="sidebar" i], [class*="facet" i], [class*="refinement" i], aside');
        if (inSidebar && seenLabels.has(text.toLowerCase().trim())) return;

        const selector = generateSelector(el as HTMLElement);
        if (selector) {
            addFilter({
                type: el.tagName === 'A' ? 'link' : 'button',
                label: text.substring(0, 50),
                selector,
                currentValue: el.getAttribute('aria-selected') === 'true' || el.classList.contains('active') ? 'active' : undefined,
            });
        }
    });

    // 5. Checkbox/radio filters (standalone, not in panels)
    document.querySelectorAll('input[type="checkbox"], input[type="radio"]').forEach(inp => {
        if (!isVisible(inp as HTMLElement)) return;
        const input = inp as HTMLInputElement;
        const labelEl = input.labels?.[0] || input.closest('label') || input.parentElement;
        const text = (labelEl?.textContent || '').trim();
        if (text.length < 2 || text.length > 80 || ignoreKeywords.test(text)) return;

        const selector = generateSelector(inp as HTMLElement);
        if (selector) {
            addFilter({
                type: input.type,
                label: text.substring(0, 50),
                selector,
                currentValue: input.checked ? 'checked' : 'unchecked',
            });
        }
    });

    // 6. Accordion/expandable filter sections (details/summary)
    document.querySelectorAll('details, [data-accordion], [class*="accordion" i], [class*="collapsible" i], [class*="expandable" i]').forEach(el => {
        if (!isVisible(el as HTMLElement)) return;
        const summary = el.querySelector('summary, [class*="header" i], [class*="title" i]');
        if (!summary) return;
        const text = (summary.textContent || '').trim();
        if (text.length < 2 || text.length > 60 || ignoreKeywords.test(text)) return;
        if (filterKeywords.test(text)) {
            const selector = generateSelector(summary as HTMLElement);
            if (selector) {
                addFilter({
                    type: 'accordion-filter',
                    label: text.substring(0, 50),
                    selector,
                    currentValue: (el as HTMLDetailsElement).open ? 'expanded' : 'collapsed',
                });
            }
        }
    });

    // 7. Data attribute filters (common on React/modern sites)
    document.querySelectorAll('[data-filter], [data-sort], [data-value], [data-purpose*="filter"], [data-testid*="filter"], [data-testid*="sort"]').forEach(el => {
        if (!isVisible(el as HTMLElement)) return;
        const text = (el.textContent || '').trim();
        if (ignoreKeywords.test(text)) return;
        const selector = generateSelector(el as HTMLElement);
        if (selector && text.length > 1 && text.length < 60) {
            addFilter({
                type: 'data-filter',
                label: text.substring(0, 50),
                selector,
                currentValue: el.getAttribute('data-value') || el.getAttribute('data-filter') || undefined,
            });
        }
    });

    return filters.slice(0, 80); // Cap at 80 to prevent LLM token rate limits (Groq 8k TPM limit)
}


// ─── On-page result badge overlay system ───
// Injects ASTRA rank badges directly onto page result items
const BADGE_RANK_ICONS = ['🏆', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣'];
const BADGE_COLORS = ['#f59e0b', '#9ca3af', '#cd7c2f', '#6366f1', '#6366f1', '#6366f1', '#6366f1', '#6366f1'];
let activeAstraBadges: HTMLElement[] = [];

function highlightResultsOnPage(results: Array<{
    rank: number; title: string; url?: string; snippet?: string;
    rating?: string; reviewCount?: string; reason?: string; badge?: string;
}>, _query: string) {
    try {
        // Validate input
        if (!results || !Array.isArray(results) || results.length === 0) {
            console.log('[ASTRA] No results to highlight');
            return;
        }

        // Remove old badges
        clearAstraBadges();

        // Inject badge styles
        if (!document.getElementById('astra-badge-styles')) {
            const style = document.createElement('style');
            style.id = 'astra-badge-styles';
            style.textContent = `
            .astra-result-badge {
                position: absolute;
                z-index: 2147483640;
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 3px 8px 3px 5px;
                border-radius: 20px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                font-size: 11px;
                font-weight: 700;
                color: white;
                cursor: pointer;
                box-shadow: 0 2px 8px rgba(0,0,0,0.25);
                transition: transform 0.15s ease, box-shadow 0.15s ease;
                white-space: nowrap;
                pointer-events: all;
                border: 1.5px solid rgba(255,255,255,0.3);
                backdrop-filter: blur(4px);
                letter-spacing: 0.3px;
            }
            .astra-result-badge:hover { transform: scale(1.05); box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
            .astra-badge-tooltip {
                display: none;
                position: absolute;
                top: calc(100% + 8px);
                left: 0;
                min-width: 260px;
                max-width: 340px;
                background: #0f172a;
                color: #e2e8f0;
                border-radius: 12px;
                padding: 12px 14px;
                font-size: 12px;
                line-height: 1.5;
                box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                border: 1px solid rgba(99,102,241,0.3);
                z-index: 2147483641;
                pointer-events: none;
            }
            .astra-result-badge:hover .astra-badge-tooltip { display: block; }
            .astra-badge-tooltip .tip-rating { color: #fbbf24; font-weight: 600; margin: 2px 0; }
            .astra-badge-tooltip .tip-reason { color: #a5b4fc; font-style: italic; margin-top: 6px; font-size: 11px; }
            .astra-badge-tooltip .tip-title { font-weight: 700; color: white; margin-bottom: 4px; }
            .astra-badge-close {
                margin-left: 4px;
                opacity: 0.7;
                font-size: 10px;
                cursor: pointer;
            }
            .astra-badge-close:hover { opacity: 1; }
            @keyframes astra-badge-enter {
                from { opacity: 0; transform: scale(0.5) translateY(-4px); }
                to   { opacity: 1; transform: scale(1) translateY(0); }
            }
            .astra-result-badge { animation: astra-badge-enter 0.3s cubic-bezier(0.34,1.56,0.64,1) both; }
        `;
            document.head.appendChild(style);
        }

        // Find elements and attach badges
        let attached = 0;
        for (const result of results.slice(0, 8)) {
            const el = findElementByTitle(result.title);
            if (!el) continue;

            // Find nearest card/item container — very broad to work across all sites
            const validSelectors = [
                'li', 'article', 'section',
                '[data-course-id]', '[class*="course-card"]', '[class*="course_card"]',
                '[data-asin]', '[data-component-type="s-search-result"]', '.s-result-item',
                'ytd-video-renderer', 'ytd-rich-item-renderer',
                '.s-item', '[class*="s-item"]',
                '[class*="product-card"]',
                '[class*="entity-result"]',
                '[class*="card" i]', '[class*="result" i]', '[class*="item" i]',
                '[class*="course" i]', '[class*="product" i]', '[class*="listing" i]',
                '[class*="row" i]', '[class*="entry" i]'
            ];

            // Find closest matching parent safely
            let parent: HTMLElement | null = null;
            try {
                parent = el.closest(validSelectors.join(', ')) as HTMLElement;
            } catch (e) { /* ignore invalid CSS selector errors */ }

            if (!parent) parent = el.parentElement as HTMLElement;
            if (!parent) continue;

            const computedPos = getComputedStyle(parent).position;
            if (computedPos === 'static') parent.style.position = 'relative';

            // Add subtle highlight border to the card
            const rankIdx = result.rank - 1;
            if (rankIdx < 3) {
                parent.style.outline = `2px solid ${BADGE_COLORS[rankIdx]}44`;
                parent.style.outlineOffset = '2px';
                parent.style.borderRadius = '8px';
                parent.style.transition = 'outline 0.3s ease';
            }
            const color = BADGE_COLORS[rankIdx] || '#6366f1';
            const icon = BADGE_RANK_ICONS[rankIdx] || '✦';
            const badgeLabel = result.badge || `#${result.rank}`;

            const badge = document.createElement('div');
            badge.className = 'astra-result-badge';
            badge.style.cssText = `
            background: linear-gradient(135deg, ${color}dd, ${color}99);
            top: 8px; right: 8px;
            animation-delay: ${rankIdx * 80}ms;
        `;

            // Build tooltip content
            const ratingLine = result.rating ? `<div class="tip-rating">⭐ ${result.rating}${result.reviewCount ? ` · ${result.reviewCount}` : ''}</div>` : '';
            const snippetLine = result.snippet ? `<div style="margin:4px 0;opacity:0.85">${result.snippet.substring(0, 120)}${result.snippet.length > 120 ? '…' : ''}</div>` : '';
            const reasonLine = result.reason ? `<div class="tip-reason">✦ ${result.reason}</div>` : '';

            badge.innerHTML = `
            <span>${icon}</span>
            <span>ASTRA: ${badgeLabel}</span>
            <span class="astra-badge-close" title="Dismiss">✕</span>
            <div class="astra-badge-tooltip">
                <div class="tip-title">${result.title.substring(0, 60)}${result.title.length > 60 ? '…' : ''}</div>
                ${ratingLine}
                ${snippetLine}
                ${reasonLine}
            </div>
        `;

            // Dismiss on click of ✕
            badge.querySelector('.astra-badge-close')?.addEventListener('click', (e) => {
                e.stopPropagation();
                badge.remove();
                activeAstraBadges = activeAstraBadges.filter(b => b !== badge);
            });

            parent.appendChild(badge);
            activeAstraBadges.push(badge);

            // Scroll to #1 result and move cursor to it
            if (result.rank === 1) {
                setTimeout(() => {
                    parent.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    cursorFocusElement(parent, `#1 ASTRA Pick: ${result.title.substring(0, 30)}`);
                    setTimeout(hideCursorFeedback, 3000);
                }, 500);
            }
            attached++;
        }

        // Show toast summary
        if (attached > 0) {
            showDebugToast(`✦ ASTRA highlighted ${attached} top results on the page`);
        }

        // Auto-clear badges after 30 seconds removed per user request
        // setTimeout(clearAstraBadges, 30000);
    } catch (err) {
        console.error('[ASTRA] Error highlighting results:', err);
        // Don't throw - highlighting is non-critical
    }
}

function findElementByTitle(title: string): HTMLElement | null {
    if (!title) return null;
    const searchTitle = title.toLowerCase().trim().replace(/\s+/g, ' ');
    const searchWords = searchTitle.split(' ').filter(w => w.length > 2);
    const shortTitle = searchTitle.substring(0, 40);

    // Broad selector to find ALL text-carrying elements that could be result titles
    const titleSelectors = [
        // Standard headings and links
        'h1', 'h2', 'h3', 'h4', 'h5', 'a',
        // Class-based title selectors (works across most sites)
        '[class*="title" i]', '[class*="name" i]', '[class*="heading" i]',
        // Data attribute based
        '[data-testid*="title"]', '[data-purpose*="title"]',
        // Udemy
        '[class*="course-card--course-title"]', '[data-purpose="course-title-url"]',
        // Amazon
        '.a-size-medium', '.a-size-base-plus', '[data-cy="title-recipe"]', '.s-title-instructions-style span',
        // YouTube
        '#video-title', '[id*="video-title"]', 'ytd-video-renderer h3',
        // Coursera
        '[class*="product-card"] h3',
        // eBay
        '.s-item__title',
        // LinkedIn
        '[class*="entity-result__title"]',
        // Generic spans and divs with short text (likely titles)
        'span', 'div', 'p',
    ].join(', ');

    const allTextEls = document.querySelectorAll(titleSelectors);
    let bestMatch: HTMLElement | null = null;
    let bestScore = 0;

    for (const el of Array.from(allTextEls)) {
        const rawText = (el.textContent || '').trim();
        if (!rawText || rawText.length < 5 || rawText.length > 300) continue;
        if (!isVisible(el as HTMLElement)) continue;

        const elText = rawText.toLowerCase().replace(/\s+/g, ' ');

        let score = 0;

        // Exact match
        if (elText === searchTitle) {
            score = 100;
        }
        // Element text starts with the search title
        else if (elText.startsWith(shortTitle)) {
            score = 85;
        }
        // Search title starts with element text (truncated titles on page)
        else if (searchTitle.startsWith(elText.substring(0, 30))) {
            score = 75;
        }
        // Contains the short version
        else if (elText.includes(shortTitle)) {
            score = 65;
        }
        else {
            // Word overlap scoring
            const matchedWords = searchWords.filter(w => elText.includes(w));
            const overlapRatio = matchedWords.length / Math.max(searchWords.length, 1);
            score = overlapRatio * 55;

            // Bonus if the element is a heading or link (more likely to be a title)
            if (/^(H[1-5]|A)$/.test(el.tagName)) score += 5;
        }

        // Prefer shorter, more focused elements (a title, not a whole card)
        if (rawText.length < 100) score += 3;
        if (rawText.length > 200) score -= 10;

        if (score > bestScore && score > 25) {
            bestScore = score;
            bestMatch = el as HTMLElement;
        }
    }

    return bestMatch;
}


function clearAstraBadges() {
    activeAstraBadges.forEach(b => b.remove());
    activeAstraBadges = [];
}



// ─── Smart Element Finder ───
// Scores DOM elements against a description to find the best match.
// Used by the vision pipeline to translate "what vision sees" into real DOM selectors.
function findElementByDescription(description: string, elementType?: string): string | null {
    const desc = (description || '').toLowerCase();
    const type = (elementType || '').toLowerCase();

    // Candidate selectors to try based on element type hint
    let candidates: NodeListOf<Element> | Element[];
    if (type === 'search-input' || desc.includes('search')) {
        candidates = document.querySelectorAll(
            'input[type="search"], input[name="q"], input[placeholder*="search" i], [role="search"] input, input[aria-label*="search" i]'
        );
    } else if (type === 'button' || desc.includes('button') || desc.includes('submit')) {
        candidates = document.querySelectorAll('button, [role="button"], input[type="submit"]');
    } else if (type === 'form' || desc.includes('form')) {
        candidates = document.querySelectorAll('form');
    } else {
        candidates = document.querySelectorAll('input, button, [role="button"], [role="search"], a, select, textarea');
    }

    let bestScore = 0;
    let bestEl: Element | null = null;

    for (const el of Array.from(candidates)) {
        if (!isVisible(el as HTMLElement)) continue;

        let score = 0;
        const elText = [
            el.getAttribute('placeholder'),
            el.getAttribute('aria-label'),
            el.getAttribute('name'),
            el.getAttribute('id'),
            el.getAttribute('class'),
            el.getAttribute('title'),
            el.textContent,
        ].filter(Boolean).join(' ').toLowerCase();

        // Score by keyword matches
        for (const word of desc.split(/\s+/)) {
            if (word.length > 2 && elText.includes(word)) score += 10;
        }
        // Bonus for exact type match
        if (el.tagName === 'INPUT' && (desc.includes('input') || desc.includes('search'))) score += 5;
        if (el.tagName === 'BUTTON' && desc.includes('button')) score += 5;
        // Bonus for visible / prominent position
        const rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight / 3) score += 3; // Near top of page

        if (score > bestScore) {
            bestScore = score;
            bestEl = el;
        }
    }

    if (!bestEl || bestScore === 0) return null;

    // Build a reliable selector for the found element
    if (bestEl.id) return `#${CSS.escape(bestEl.id)}`;
    if (bestEl.getAttribute('name')) return `[name="${bestEl.getAttribute('name')}"]`;
    if (bestEl.getAttribute('aria-label')) return `[aria-label="${bestEl.getAttribute('aria-label')}"]`;
    if (bestEl.getAttribute('placeholder')) return `[placeholder="${bestEl.getAttribute('placeholder')}"]`;
    // Fallback: tag + class
    const cls = Array.from(bestEl.classList).slice(0, 2).join('.');
    return cls ? `${bestEl.tagName.toLowerCase()}.${cls}` : bestEl.tagName.toLowerCase();
}

// ─── Utilities ───
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════
// ─── ASTRA Cursor System (Perplexity-style) ───
// ═══════════════════════════════════════════════
// A visual AI cursor that moves to elements before interacting with them.
// Completely self-contained, injected into the page's top layer.

let astraCursorEl: HTMLDivElement | null = null;
let astraLabelEl: HTMLDivElement | null = null;
let astraHighlightEl: HTMLDivElement | null = null;
let astraCursorX = window.innerWidth / 2;
let astraCursorY = window.innerHeight / 2;

function ensureAstraCursor() {
    if (astraCursorEl) return;

    // Inject CSS into document head
    const style = document.createElement('style');
    style.id = 'astra-cursor-styles';
    style.textContent = `
        #astra-cursor {
            position: fixed;
            width: 24px;
            height: 24px;
            pointer-events: none;
            z-index: 2147483647;
            transition: none;
        }
        #astra-cursor svg {
            filter: drop-shadow(0 0 6px rgba(99,102,241,0.9)) drop-shadow(0 0 12px rgba(99,102,241,0.6));
        }
        #astra-action-label {
            position: fixed;
            background: linear-gradient(135deg, #4f46e5, #7c3aed);
            color: white;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            font-size: 12px;
            font-weight: 600;
            padding: 4px 10px;
            border-radius: 20px;
            pointer-events: none;
            z-index: 2147483647;
            white-space: nowrap;
            box-shadow: 0 4px 12px rgba(79,70,229,0.4);
            opacity: 0;
            transition: opacity 0.2s ease;
            letter-spacing: 0.3px;
        }
        #astra-action-label.visible { opacity: 1; }
        #astra-highlight-ring {
            position: fixed;
            pointer-events: none;
            z-index: 2147483646;
            border: 2px solid #6366f1;
            border-radius: 6px;
            background: rgba(99,102,241,0.06);
            box-shadow: 0 0 0 3px rgba(99,102,241,0.2), inset 0 0 12px rgba(99,102,241,0.1);
            opacity: 0;
            transition: opacity 0.2s ease, width 0.15s ease, height 0.15s ease, top 0.15s ease, left 0.15s ease;
        }
        #astra-highlight-ring.visible { opacity: 1; }
        @keyframes astra-cursor-pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.15); }
        }
        #astra-cursor.clicking svg {
            animation: astra-cursor-pulse 0.2s ease;
        }
    `;
    if (!document.getElementById('astra-cursor-styles')) {
        document.head.appendChild(style);
    }

    // Cursor element (SVG pointer with glow)
    astraCursorEl = document.createElement('div');
    astraCursorEl.id = 'astra-cursor';
    astraCursorEl.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 2L16 9.5L10.5 11.5L8.5 17.5L4 2Z" fill="#6366f1" stroke="white" stroke-width="1.2" stroke-linejoin="round"/>
            <circle cx="16" cy="16" r="3" fill="#a5b4fc" opacity="0.9"/>
        </svg>
    `;
    astraCursorEl.style.cssText = `left:${astraCursorX}px;top:${astraCursorY}px;`;
    document.documentElement.appendChild(astraCursorEl);

    // Action label
    astraLabelEl = document.createElement('div');
    astraLabelEl.id = 'astra-action-label';
    document.documentElement.appendChild(astraLabelEl);

    // Highlight ring
    astraHighlightEl = document.createElement('div');
    astraHighlightEl.id = 'astra-highlight-ring';
    document.documentElement.appendChild(astraHighlightEl);
}

function removeAstraCursor() {
    astraCursorEl?.remove(); astraCursorEl = null;
    astraLabelEl?.remove(); astraLabelEl = null;
    astraHighlightEl?.remove(); astraHighlightEl = null;
}

// Eased cursor movement animation
async function moveCursorTo(targetX: number, targetY: number, durationMs = 600): Promise<void> {
    ensureAstraCursor();
    const startX = astraCursorX;
    const startY = astraCursorY;
    const startTime = performance.now();

    return new Promise((resolve) => {
        function frame(now: number) {
            const elapsed = now - startTime;
            const progress = Math.min(1, elapsed / durationMs);
            // Ease in-out cubic
            const eased = progress < 0.5
                ? 4 * progress * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 3) / 2;

            astraCursorX = startX + (targetX - startX) * eased;
            astraCursorY = startY + (targetY - startY) * eased;

            if (astraCursorEl) {
                astraCursorEl.style.left = `${astraCursorX - 4}px`;
                astraCursorEl.style.top = `${astraCursorY - 2}px`;
            }

            if (progress < 1) {
                requestAnimationFrame(frame);
            } else {
                resolve();
            }
        }
        requestAnimationFrame(frame);
    });
}

// Move cursor to a DOM element and highlight it
async function cursorFocusElement(el: HTMLElement, label: string): Promise<void> {
    ensureAstraCursor();
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Animate cursor movement
    await moveCursorTo(centerX, centerY, 500);

    // Show highlight ring around element
    if (astraHighlightEl) {
        const padding = 4;
        astraHighlightEl.style.left = `${rect.left - padding}px`;
        astraHighlightEl.style.top = `${rect.top - padding}px`;
        astraHighlightEl.style.width = `${rect.width + padding * 2}px`;
        astraHighlightEl.style.height = `${rect.height + padding * 2}px`;
        astraHighlightEl.classList.add('visible');
    }

    // Show action label above the element
    if (astraLabelEl) {
        astraLabelEl.textContent = `✦ ASTRA: ${label}`;
        astraLabelEl.style.left = `${rect.left}px`;
        astraLabelEl.style.top = `${Math.max(4, rect.top - 32)}px`;
        astraLabelEl.classList.add('visible');
    }

    await sleep(200);
}

function cursorClick() {
    if (astraCursorEl) {
        astraCursorEl.classList.add('clicking');
        setTimeout(() => astraCursorEl?.classList.remove('clicking'), 250);
    }
}

function hideCursorFeedback() {
    astraHighlightEl?.classList.remove('visible');
    astraLabelEl?.classList.remove('visible');
}

// ═══════════════════════════════════════════════
// ─── Astra UI (Shadow DOM) ───
// ═══════════════════════════════════════════════
class AstraUI {
    private container: HTMLDivElement;
    private shadow: ShadowRoot;
    private toastElement: HTMLDivElement | null = null;
    private overlayElement: HTMLDivElement | null = null;

    constructor() {
        this.container = document.createElement('div');
        this.container.id = 'astra-ui-host';
        Object.assign(this.container.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '0',
            height: '0',
            zIndex: '2147483647',
            pointerEvents: 'none',
        });
        document.body.appendChild(this.container);
        this.shadow = this.container.attachShadow({ mode: 'closed' });

        // Inject global styles for our UI
        const style = document.createElement('style');
        style.textContent = `
            .astra-toast {
                position: fixed;
                bottom: 20px;
                right: 20px;
                background-color: #111827; /* gray-900 */
                color: #f3f4f6; /* gray-100 */
                padding: 12px 20px;
                border-radius: 8px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                font-size: 14px;
                font-weight: 500;
                box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
                border: 1px solid #374151;
                opacity: 0;
                transform: translateY(10px);
                transition: opacity 0.3s ease, transform 0.3s ease;
                z-index: 9999;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .astra-toast.visible {
                opacity: 1;
                transform: translateY(0);
            }
            .astra-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                pointer-events: none;
                border: 4px solid #6366f1; /* indigo-500 */
                box-sizing: border-box;
                box-shadow: inset 0 0 50px rgba(99, 102, 241, 0.3);
                opacity: 0;
                transition: opacity 0.3s ease;
                z-index: 9998;
            }
            .astra-scan-line {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 4px;
                background: linear-gradient(90deg, transparent, #6366f1, transparent);
                box-shadow: 0 0 15px #6366f1;
                animation: scan 2s linear infinite;
            }
            @keyframes scan {
                0% { top: 0%; opacity: 0; }
                10% { opacity: 1; }
                90% { opacity: 1; }
                100% { top: 100%; opacity: 0; }
            }
        `;
        this.shadow.appendChild(style);
    }

    showToast(message: string) {
        if (this.toastElement) this.toastElement.remove();

        this.toastElement = document.createElement('div');
        this.toastElement.className = 'astra-toast';
        this.toastElement.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
            </svg>
            <span>${message}</span>
        `;

        this.shadow.appendChild(this.toastElement);

        // Trigger animation
        requestAnimationFrame(() => this.toastElement?.classList.add('visible'));

        setTimeout(() => {
            if (this.toastElement) {
                this.toastElement.classList.remove('visible');
                setTimeout(() => this.toastElement?.remove(), 300);
            }
        }, 3000);
    }

    showOverlay() {
        if (this.overlayElement) return;

        this.overlayElement = document.createElement('div');
        this.overlayElement.className = 'astra-overlay';

        const scanLine = document.createElement('div');
        scanLine.className = 'astra-scan-line';
        this.overlayElement.appendChild(scanLine);

        this.shadow.appendChild(this.overlayElement);
        requestAnimationFrame(() => this.overlayElement!.style.opacity = '1');
    }

    hideOverlay() {
        if (!this.overlayElement) return;
        this.overlayElement.style.opacity = '0';
        setTimeout(() => {
            this.overlayElement?.remove();
            this.overlayElement = null;
        }, 300);
    }
}


// Initialize Global UI (Lazy)
let astraUI: AstraUI | null = null;

function getAstraUI(): AstraUI {
    if (!astraUI) {
        if (!document.body) throw new Error('Document body not ready');
        astraUI = new AstraUI();
    }
    return astraUI;
}

function showDebugToast(msg: string) {
    if (document.body) getAstraUI().showToast(msg);
    else console.warn('[ASTRA] Body not ready for toast:', msg);
}
function showScanningOverlay() {
    if (document.body) getAstraUI().showOverlay();
}
function hideScanningOverlay() {
    if (document.body && astraUI) astraUI.hideOverlay();
}

// Ensure init on load
if (document.body) {
    // getAstraUI().showToast('ASTRA: Connected 🟢');
} else {
    window.addEventListener('DOMContentLoaded', () => {
        // getAstraUI().showToast('ASTRA: Connected 🟢');
    });
}

function isVisible(el: HTMLElement): boolean {
    // Allow hidden inputs/labels to be clicked by ASTRA if they are in sidebars
    const isFilterPart = el.tagName === 'INPUT' || el.tagName === 'LABEL';
    if (isFilterPart) return true;

    if (!el.offsetParent && el.tagName !== 'BODY') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

// ═══════════════════════════════════════════════
// ─── Full Page Analyzer (Visually Animated) ───
// ═══════════════════════════════════════════════
async function analyzePage(message: AnalyzePageMessage): Promise<PageAnalysisData> {
    const { maxScrolls = 15, scrollDelay = 600, includeStructure = true } = message.payload;

    showScanningOverlay();
    ensureAstraCursor();

    // ─── Inject scan progress HUD ───
    let scanHud = document.getElementById('astra-scan-hud') as HTMLElement;
    if (!scanHud) {
        scanHud = document.createElement('div');
        scanHud.id = 'astra-scan-hud';
        scanHud.style.cssText = `
            position: fixed;
            top: 16px;
            right: 16px;
            z-index: 2147483645;
            background: linear-gradient(135deg, #0f172aee, #1e293bee);
            color: #e2e8f0;
            padding: 10px 18px;
            border-radius: 12px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            font-size: 13px;
            font-weight: 600;
            box-shadow: 0 4px 20px rgba(0,0,0,0.4);
            border: 1px solid rgba(99,102,241,0.4);
            display: flex;
            align-items: center;
            gap: 10px;
            backdrop-filter: blur(8px);
            transition: opacity 0.3s ease;
        `;
        document.body.appendChild(scanHud);
    }

    // ─── Inject scan-line (moving highlight bar) ───
    let scanLine = document.getElementById('astra-scan-line') as HTMLElement;
    if (!scanLine) {
        scanLine = document.createElement('div');
        scanLine.id = 'astra-scan-line';
        scanLine.style.cssText = `
            position: fixed;
            left: 0;
            right: 0;
            height: 3px;
            top: 50%;
            z-index: 2147483644;
            background: linear-gradient(90deg, transparent, #6366f1, #a78bfa, #6366f1, transparent);
            box-shadow: 0 0 12px rgba(99,102,241,0.6);
            pointer-events: none;
            transition: opacity 0.3s ease;
        `;
        document.body.appendChild(scanLine);
    }

    const updateScanHud = (text: string) => {
        if (scanHud) scanHud.innerHTML = `<span style="color:#a78bfa">✦</span> ${text}`;
    };

    const viewportHeight = window.innerHeight;
    const totalHeight = document.documentElement.scrollHeight;

    // Scroll to top with smooth animation
    updateScanHud('ASTRA: Starting scan...');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await sleep(500);

    const viewportSnapshots: ViewportSnapshot[] = [];
    const seenTextChunks = new Set<string>();
    let scrollCount = 0;

    while (scrollCount < maxScrolls) {
        const currentScrollY = window.scrollY;
        const progress = Math.min(100, Math.round((currentScrollY / Math.max(totalHeight - viewportHeight, 1)) * 100));

        // Update HUD with viewport number and progress
        updateScanHud(`ASTRA: Scanning viewport ${scrollCount + 1}/${maxScrolls} &nbsp;·&nbsp; ${progress}%`);

        // Move cursor along right edge to show scanning
        const cursorEl = document.getElementById('astra-cursor');
        if (cursorEl) {
            const cursorY = viewportHeight * 0.4 + (scrollCount % 3) * 60;
            cursorEl.style.transition = 'top 0.4s ease, left 0.4s ease';
            cursorEl.style.left = `${window.innerWidth - 80}px`;
            cursorEl.style.top = `${cursorY}px`;
            cursorEl.style.display = 'block';
        }

        // Capture visible text
        const visibleText = getVisibleText();
        const visibleInteractive = countVisibleInteractive();
        const textFingerprint = visibleText.substring(0, 200);

        if (!seenTextChunks.has(textFingerprint) && visibleText.length > 10) {
            seenTextChunks.add(textFingerprint);
            viewportSnapshots.push({
                scrollY: currentScrollY,
                visibleText: visibleText.substring(0, 3000),
                visibleElements: visibleInteractive,
            });
        }

        const nextScrollY = currentScrollY + viewportHeight * 0.85;
        if (nextScrollY >= totalHeight - viewportHeight) {
            // Scroll to bottom
            updateScanHud(`ASTRA: Reaching bottom... &nbsp;·&nbsp; 100%`);
            window.scrollTo({ top: totalHeight - viewportHeight, behavior: 'smooth' });
            await sleep(600);
            const bottomText = getVisibleText();
            const bottomFp = bottomText.substring(0, 200);
            if (!seenTextChunks.has(bottomFp) && bottomText.length > 10) {
                viewportSnapshots.push({
                    scrollY: totalHeight - viewportHeight,
                    visibleText: bottomText.substring(0, 3000),
                    visibleElements: countVisibleInteractive(),
                });
            }
            break;
        }

        // Smooth scroll to next viewport
        window.scrollTo({ top: nextScrollY, behavior: 'smooth' });
        await sleep(scrollDelay);
        scrollCount++;
    }

    // Scroll back to top smoothly
    updateScanHud('ASTRA: Analyzing content...');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await sleep(800);

    const fullText = getFullPageText();
    const meta = extractMeta();
    const sections = includeStructure ? extractSections() : [];
    const links = extractLinks();
    const forms = extractForms();
    const tables = extractTables();
    const images = extractImages();
    const scrollDepth = Math.min(100, ((scrollCount * viewportHeight * 0.85) / totalHeight) * 100);

    // Clean up visual elements
    updateScanHud('ASTRA: Scan complete ✓');
    await sleep(600);
    scanHud?.remove();
    scanLine?.remove();
    hideScanningOverlay();
    hideCursorFeedback();
    setTimeout(() => removeAstraCursor(), 500);

    return {
        url: window.location.href,
        title: document.title,
        meta,
        fullText: fullText.substring(0, 15000),
        sections,
        links: links.slice(0, 100),
        forms,
        tables: tables.slice(0, 10),
        images: images.slice(0, 50),
        scrollDepth,
        totalHeight,
        viewportHeight,
        viewportSnapshots,
    };
}

function getFullPageText(): string {
    const clone = document.body.cloneNode(true) as HTMLElement;
    const removeSelectors = ['script', 'style', 'noscript', 'iframe', 'svg', 'nav', 'footer', 'header'];
    for (const sel of removeSelectors) {
        clone.querySelectorAll(sel).forEach((el) => el.remove());
    }
    const text = clone.innerText || clone.textContent || '';
    return text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
}

function getVisibleText(): string {
    const viewportTop = window.scrollY;
    const viewportBottom = viewportTop + window.innerHeight;
    const textParts: string[] = [];

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const tag = parent.tagName.toLowerCase();
            if (['script', 'style', 'noscript'].includes(tag)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        if (!parent) continue;
        const rect = parent.getBoundingClientRect();
        const absTop = rect.top + window.scrollY;
        const absBottom = rect.bottom + window.scrollY;

        if (absBottom > viewportTop && absTop < viewportBottom) {
            const text = node.textContent?.trim();
            if (text && text.length > 1) {
                textParts.push(text);
            }
        }
    }
    return textParts.join(' ').replace(/\s+/g, ' ').trim();
}

function countVisibleInteractive(): number {
    const selectors = 'a, button, input, textarea, select, [role="button"], [role="link"], [onclick]';
    let count = 0;
    const elements = document.querySelectorAll(selectors);
    for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight && rect.bottom > 0 && rect.width > 0 && rect.height > 0) {
            count++;
        }
    }
    return count;
}

function extractMeta(): PageMeta {
    const getMeta = (name: string) =>
        document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.getAttribute('content') || undefined;
    return {
        description: getMeta('description'),
        keywords: getMeta('keywords'),
        ogTitle: getMeta('og:title'),
        ogDescription: getMeta('og:description'),
        canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || undefined,
        language: document.documentElement.lang || undefined,
    };
}

function extractSections(): PageSection[] {
    const sections: PageSection[] = [];
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (const heading of headings) {
        const level = parseInt(heading.tagName[1]);
        const headingText = (heading.textContent || '').trim();
        if (!headingText) continue;
        let textContent = '';
        let sibling = heading.nextElementSibling;
        while (sibling && !sibling.tagName.match(/^H[1-6]$/)) {
            const text = (sibling.textContent || '').trim();
            if (text) textContent += text + '\n';
            sibling = sibling.nextElementSibling;
        }
        sections.push({
            heading: headingText.substring(0, 200),
            level,
            text: textContent.substring(0, 1000),
        });
    }
    return sections.slice(0, 50);
}

function extractLinks(): PageLink[] {
    const links: PageLink[] = [];
    const anchors = document.querySelectorAll('a[href]');
    const seenHrefs = new Set<string>();
    for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        if (!href || href === '#' || href.startsWith('javascript:')) continue;
        if (seenHrefs.has(href)) continue;
        seenHrefs.add(href);
        const text = (a.textContent || '').trim().substring(0, 100);
        if (!text) continue;
        const isExternal = href.startsWith('http') && !href.includes(window.location.hostname);
        links.push({ text, href, isExternal });
    }
    return links;
}

function extractForms(): PageForm[] {
    const forms: PageForm[] = [];
    const formEls = document.querySelectorAll('form');
    for (const form of formEls) {
        const inputs = Array.from(form.querySelectorAll('input, textarea, select')).map((input) => {
            const el = input as HTMLInputElement;
            const label = el.labels?.[0]?.textContent?.trim() || el.getAttribute('aria-label') || undefined;
            return {
                type: el.type || el.tagName.toLowerCase(),
                name: el.name || undefined,
                placeholder: el.placeholder || undefined,
                label,
                value: el.type === 'password' ? undefined : el.value || undefined,
            };
        });
        forms.push({ action: form.action || undefined, inputs });
    }
    const standaloneInputs = document.querySelectorAll('input:not(form input), textarea:not(form textarea)');
    if (standaloneInputs.length > 0) {
        const inputs = Array.from(standaloneInputs).map((input) => {
            const el = input as HTMLInputElement;
            return {
                type: el.type || el.tagName.toLowerCase(),
                name: el.name || undefined,
                placeholder: el.placeholder || undefined,
                label: el.getAttribute('aria-label') || undefined,
                value: el.type === 'password' ? undefined : el.value || undefined,
            };
        });
        forms.push({ inputs });
    }
    return forms.slice(0, 10);
}

function extractTables(): PageTable[] {
    const tables: PageTable[] = [];
    const tableEls = document.querySelectorAll('table');
    for (const table of tableEls) {
        const headerRow = table.querySelector('thead tr, tr:first-child');
        const headers = headerRow
            ? Array.from(headerRow.querySelectorAll('th, td')).map((c) => (c.textContent || '').trim().substring(0, 100))
            : [];
        const bodyRows = table.querySelectorAll('tbody tr, tr:not(:first-child)');
        const rows: string[][] = [];
        for (const row of Array.from(bodyRows).slice(0, 20)) {
            const cells = Array.from(row.querySelectorAll('td, th')).map((c) =>
                (c.textContent || '').trim().substring(0, 100)
            );
            if (cells.some((c) => c.length > 0)) rows.push(cells);
        }
        if (headers.length > 0 || rows.length > 0) {
            tables.push({
                headers,
                rows,
                rowCount: table.querySelectorAll('tbody tr, tr').length,
            });
        }
    }
    return tables;
}

function extractImages(): PageImage[] {
    const images: PageImage[] = [];
    const imgEls = document.querySelectorAll('img[src]');
    for (const img of imgEls) {
        const el = img as HTMLImageElement;
        if (el.naturalWidth < 50 || el.naturalHeight < 50) continue;
        images.push({
            src: el.src,
            alt: el.alt || undefined,
            width: el.naturalWidth || undefined,
            height: el.naturalHeight || undefined,
        });
    }
    return images;
}

// ═══════════════════════════════════════════════
// ─── DOM Action Executor ───
// ═══════════════════════════════════════════════
// ─── Deep Shadow DOM Search ───
function findSearchInputDeep(root: Document | ShadowRoot | HTMLElement = document): HTMLInputElement | null {
    // Comprehensive search input selectors — site-specific first, then generic
    // Tried in order of specificity so the most likely match comes first
    const searchSelectors = [
        // ─── Site-specific (highest confidence) ───
        '#twotabsearchtextbox',                      // Amazon
        '#nav-search-bar-form input[type="text"]',   // Amazon alternate
        'input#search',                              // YouTube
        'ytd-searchbox input',                       // YouTube Web Components
        '#gh-ac',                                    // eBay
        '#gh-search-box input',                      // eBay alternate
        'input[name="q"][title*="Search" i]',        // Flipkart, generic
        '#searchInput',                              // Wikipedia, many sites
        '#search-input',                             // Many sites
        '.search-input input',                       // Many sites
        '#NavSearch input',                          // AliExpress
        'input[data-purpose*="search" i]',           // Udemy
        '.ud-text-input[placeholder*="search" i]',  // Udemy
        'input[placeholder*="Search courses" i]',   // Udemy/Coursera
        '#search-bar input',                         // Generic
        // ─── ARIA / Role-based (high confidence) ───
        '[role="searchbox"]',
        '[role="search"] input[type="text"]',
        '[role="search"] input[type="search"]',
        'input[aria-label*="search" i]',
        'input[aria-label*="find" i]',
        'input[aria-placeholder*="search" i]',
        // ─── Standard HTML types ───
        'input[type="search"]',
        'input[name="q"]',
        'input[name="search"]',
        'input[name="query"]',
        'input[name="keyword"]',
        'input[name="keywords"]',
        'input[name="s"]',
        'input[name="text"]',
        // ─── Placeholder-based ───
        'input[placeholder*="search" i]',
        'input[placeholder*="find" i]',
        'input[placeholder*="look for" i]',
        'input[placeholder*="what are you looking" i]',
        // ─── Form-based ───
        'form[role="search"] input',
        'form[action*="search"] input[type="text"]',
        'form[action*="search"] input[type="search"]',
        'form[class*="search" i] input',
        'form[id*="search" i] input',
        // ─── Class-based ───
        '[class*="search-input" i] input',
        '[class*="searchInput" i] input',
        '[class*="searchbar" i] input',
        '[class*="search-bar" i] input',
        '[class*="search-box" i] input',
        '[class*="searchBox" i] input',
    ];

    for (const sel of searchSelectors) {
        try {
            const el = root.querySelector(sel);
            if (el && isVisible(el as HTMLElement)) return el as HTMLInputElement;
        } catch (_) { /* ignore invalid selectors */ }
    }

    // If not found when checking with visibility, try without visibility check
    // (the search bar might be in the sticky header / scrolled out of view)
    for (const sel of searchSelectors.slice(0, 15)) {
        try {
            const el = root.querySelector(sel);
            if (el) return el as HTMLInputElement; // found but maybe not visible
        } catch (_) { /* ignore invalid selectors */ }
    }

    // 2. Traverse Shadow Roots
    const walker = document.createTreeWalker(
        root instanceof Document ? root.body : root,
        NodeFilter.SHOW_ELEMENT,
        {
            acceptNode(node) {
                return (node as Element).shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            }
        }
    );

    // Collect all shadow hosts first to avoid walker invalidation
    const shadowHosts: Element[] = [];
    if ((root as Element).shadowRoot) {
        // Checking the root itself if it's an element
    }

    // We need to manually traverse because TreeWalker doesn't pierce Shadow DOM automatically
    const findAllShadowHosts = (node: Node): Element[] => {
        const hosts: Element[] = [];
        if (node instanceof Element && node.shadowRoot) hosts.push(node);

        const childNodes = node instanceof Element && node.shadowRoot
            ? Array.from(node.shadowRoot.children)
            : Array.from(node.childNodes);

        for (const child of childNodes) {
            hosts.push(...findAllShadowHosts(child));
        }
        return hosts;
    };

    // Simplified recursive search for robustness
    const attemptSearch = (node: Node): HTMLInputElement | null => {
        if (node instanceof HTMLElement && isVisible(node)) {
            // Is this the input?
            if (node.tagName === 'INPUT') {
                const inp = node as HTMLInputElement;
                if (inp.type === 'search' || inp.name === 'q' || (inp.placeholder && inp.placeholder.toLowerCase().includes('search'))) {
                    return inp;
                }
            }
        }

        // Check Shadow Root
        if (node instanceof Element && node.shadowRoot) {
            const found = attemptSearch(node.shadowRoot);
            if (found) return found;
        }

        // Check Children
        for (const child of Array.from(node.childNodes)) {
            const found = attemptSearch(child);
            if (found) return found;
        }

        return null;
    };

    return attemptSearch(document.body);
}

// ═══════════════════════════════════════════════
// ─── DOM Action Executor ───
// ═══════════════════════════════════════════════
async function handleDOMAction(message: ExecuteDOMActionMessage) {
    const { action, selector, value, duration, direction, amount } = message.payload;

    switch (action) {
        case 'click': {
            if (!selector) throw new Error('click requires a selector');
            const el = document.querySelector(selector) as HTMLElement;
            if (!el) throw new Error(`Element not found: ${selector}`);
            // ─── Visual cursor feedback ───
            await cursorFocusElement(el, 'Clicking...');
            cursorClick();
            el.click();
            await sleep(300);
            hideCursorFeedback();
            setTimeout(() => removeAstraCursor(), 1000);
            return { success: true, data: { clicked: selector } };
        }

        case 'type': {
            if (!selector) throw new Error('type requires a selector');
            if (!value) throw new Error('type requires a value');
            const el = document.querySelector(selector) as HTMLInputElement;
            if (!el) throw new Error(`Element not found: ${selector}`);
            // ─── Visual cursor feedback ───
            await cursorFocusElement(el, `Typing "${value.substring(0, 20)}${value.length > 20 ? '...' : ''}"`);
            el.focus();
            el.value = '';
            for (const char of value) {
                el.value += char;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                await sleep(18);
            }
            el.dispatchEvent(new Event('change', { bubbles: true }));
            hideCursorFeedback();
            return { success: true, data: { typed: value, into: selector } };
        }

        case 'scroll': {
            const scrollAmount = amount ?? 500;
            const dir = direction === 'up' ? -1 : 1;
            if (selector) {
                const el = document.querySelector(selector);
                if (!el) throw new Error(`Element not found: ${selector}`);
                el.scrollBy({ top: scrollAmount * dir, behavior: 'smooth' });
            } else {
                window.scrollBy({ top: scrollAmount * dir, behavior: 'smooth' });
            }
            return { success: true, data: { scrolled: scrollAmount * dir } };
        }

        case 'wait': {
            const ms = duration ?? 1000;
            await sleep(ms);
            return { success: true, data: { waited: ms } };
        }

        case 'search': {
            if (!value) throw new Error('search requires a value');

            // Try Deep Search first
            let el = findSearchInputDeep();

            // Fallback to light DOM heuristics if deep search fails (unlikely if recursive works)
            if (!el) {
                const searchSelectors = [
                    // Amazon specific
                    '#twotabsearchtextbox',
                    '#nav-search-bar-form input[type="text"]',
                    // YouTube specific
                    'input#search', 'ytd-searchbox input',
                    // eBay specific
                    '#gh-ac',
                    // Flipkart
                    'input[name="q"][title*="Search" i]',
                    // Generic selectors
                    'input[type="search"]',
                    'input[name="q"]',
                    'input[name="search"]',
                    'input[name="query"]',
                    'input[name="keyword"]',
                    'input[name="keywords"]',
                    'input[placeholder*="search" i]',
                    'input[placeholder*="find" i]',
                    'form[role="search"] input',
                    '[role="searchbox"]',
                    'input[aria-label*="search" i]',
                    'input[aria-label*="find" i]',
                ];
                for (const sel of searchSelectors) {
                    const candidate = document.querySelector(sel);
                    if (candidate && isVisible(candidate as HTMLElement)) {
                        el = candidate as HTMLInputElement;
                        break;
                    }
                }
            }

            if (!el) {
                throw new Error('Could not find a VISIBLE search input on this page');
            }

            if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
                // Try to find input inside if we found a container
                const inner = el.querySelector('input');
                if (inner) el = inner;
            }

            // ─── Visual cursor feedback ───
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await sleep(200);
            await cursorFocusElement(el as HTMLElement, `Searching for "${value.substring(0, 30)}${value.length > 30 ? '...' : ''}"`);

            el.focus();
            el.click(); // Ensure it's active


            // Helper for React-safe value setting
            const setNativeValue = (element: HTMLInputElement, val: string) => {
                const valueSetter = Object.getOwnPropertyDescriptor(element, 'value')?.set;
                const prototype = Object.getPrototypeOf(element);
                const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

                if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
                    prototypeValueSetter.call(element, val);
                } else if (valueSetter) {
                    valueSetter.call(element, val);
                } else {
                    element.value = val;
                }

                element.dispatchEvent(new Event('input', { bubbles: true }));
            };

            // 1. Visually simulate typing (for user benefit) - FAST
            let currentVal = '';
            for (const char of value) {
                currentVal += char;
                setNativeValue(el, currentVal);
                await sleep(5 + Math.random() * 5);
            }

            // 2. Force set final value
            setNativeValue(el, value);
            el.dispatchEvent(new Event('change', { bubbles: true }));

            // 3. Submit (Hardened)
            await sleep(100); // Reduced from 300

            // ─── CRITICAL: Return success BEFORE triggering navigation ───
            // The page may navigate after submit, which would unload this script
            // before we can send the response. Use setTimeout to ensure response
            // is sent first.
            setTimeout(() => {
                const enterEvent = {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true,
                    cancelable: true,
                    view: window
                };

                el.dispatchEvent(new KeyboardEvent('keydown', enterEvent));
                el.dispatchEvent(new KeyboardEvent('keypress', enterEvent));
                el.dispatchEvent(new KeyboardEvent('keyup', enterEvent));

                // 4. Try form submit if exists
                if (el.form) {
                    const submitBtn = el.form.querySelector('button[type="submit"], input[type="submit"]');
                    if (submitBtn) {
                        (submitBtn as HTMLElement).click();
                    } else {
                        el.form.requestSubmit();
                    }
                }

                // 5. Try site-specific search buttons as extra insurance
                const searchBtnSelectors = [
                    // Amazon
                    '#nav-search-submit-button', '#nav-search-submit-text',
                    'input[type="submit"][value*="Go"]',
                    // YouTube
                    'button#search-icon-legacy', '#search-icon-legacy',
                    // eBay
                    '#gh-btn',
                    // Generic
                    'button[type="submit"]',
                    'button[aria-label*="search" i]',
                    'button[aria-label*="find" i]',
                    '[class*="search" i] button',
                    '[class*="search" i] [type="submit"]',
                ];
                for (const btnSel of searchBtnSelectors) {
                    const btn = document.querySelector(btnSel) as HTMLElement;
                    if (btn && isVisible(btn)) {
                        btn.click();
                        break;
                    }
                }

                // 6. Nearby sibling button fallback
                if (!el.form) {
                    const nextBtn = el.nextElementSibling;
                    if (nextBtn && (nextBtn.tagName === 'BUTTON' || nextBtn.getAttribute('role') === 'button')) {
                        (nextBtn as HTMLElement).click();
                    }
                    const prevBtn = el.previousElementSibling;
                    if (prevBtn && (prevBtn.tagName === 'BUTTON' || prevBtn.getAttribute('role') === 'button')) {
                        (prevBtn as HTMLElement).click();
                    }
                }

                setTimeout(() => { el.style.outline = ''; }, 1000); // Clear outline sooner
            }, 50); // Small delay to ensure response is sent first

            return { success: true, data: { searched: value } };
        }

        default:
            throw new Error(`Unknown action: ${action}`);
    }
}



// ─── DOM Reader ───
function readDOM(message: ReadDOMMessage) {
    const { selector, maxDepth = 5, includeText = true } = message.payload;

    const root = selector
        ? document.querySelector(selector) ?? document.body
        : document.body;

    const elements = extractElements(root as HTMLElement, maxDepth, includeText);

    return {
        url: window.location.href,
        title: document.title,
        elements,
    };
}

function extractElements(
    el: HTMLElement,
    maxDepth: number,
    includeText: boolean,
    depth = 0,
): DOMElement[] {
    if (depth >= maxDepth) return [];

    const results: DOMElement[] = [];

    for (const child of Array.from(el.children)) {
        const htmlChild = child as HTMLElement;
        const tag = htmlChild.tagName.toLowerCase();

        if (['script', 'style', 'noscript', 'svg', 'path'].includes(tag)) continue;

        const element: DOMElement = { tag };

        if (htmlChild.id) element.id = htmlChild.id;
        if (htmlChild.className && typeof htmlChild.className === 'string') {
            element.className = htmlChild.className.trim().substring(0, 100);
        }

        const href = htmlChild.getAttribute('href');
        if (href) element.href = href;

        const inputValue = (htmlChild as HTMLInputElement).value;
        if (inputValue) element.value = inputValue;

        const rect = htmlChild.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            element.rect = {
                top: Math.round(rect.top),
                left: Math.round(rect.left),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
            };
        }

        if (includeText) {
            const directText = Array.from(htmlChild.childNodes)
                .filter((n) => n.nodeType === Node.TEXT_NODE)
                .map((n) => n.textContent?.trim())
                .filter(Boolean)
                .join(' ')
                .substring(0, 200);
            if (directText) element.text = directText;
        }

        const role = htmlChild.getAttribute('role');
        const ariaLabel = htmlChild.getAttribute('aria-label');
        const dataTestId = htmlChild.getAttribute('data-testid');
        const type = htmlChild.getAttribute('type');
        const name = htmlChild.getAttribute('name');
        const placeholder = htmlChild.getAttribute('placeholder');

        if (role || ariaLabel || dataTestId || type || name || placeholder) {
            element.attributes = {};
            if (role) element.attributes.role = role;
            if (ariaLabel) element.attributes['aria-label'] = ariaLabel;
            if (dataTestId) element.attributes['data-testid'] = dataTestId;
            if (type) element.attributes.type = type;
            if (name) element.attributes.name = name;
            if (placeholder) element.attributes.placeholder = placeholder;
        }

        if (htmlChild.children.length > 0) {
            const children = extractElements(htmlChild, maxDepth, includeText, depth + 1);
            if (children.length > 0) element.children = children;
        }

        results.push(element);
    }

    return results;
}

console.log('[ASTRA] Content script loaded on', window.location.href);

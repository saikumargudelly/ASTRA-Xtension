/**
 * Regional URL mapping for location-aware navigation.
 * When the user is in India, open amazon.in / netflix (in-en); in US, open amazon.com / netflix.com.
 */

export type RegionCode = 'IN' | 'US' | 'UK' | 'DE' | 'FR' | 'JP' | 'AU' | 'CA' | 'BR' | 'MX';

/** Known site keys (lowercase) that have regional variants */
export const REGIONAL_SITES = ['netflix', 'amazon', 'prime', 'prime video', 'primevideo'] as const;

/** Default region when none is provided (e.g. from locale or URL) */
export const DEFAULT_REGION: RegionCode = 'US';

/**
 * Map of canonical site name (from intent/targetSite) to region → URL.
 * Use lowercase keys. Include common aliases (e.g. "prime video" → same as "prime").
 */
const SITE_REGIONAL_URLS: Record<string, Partial<Record<RegionCode, string>>> = {
    netflix: {
        US: 'https://www.netflix.com',
        IN: 'https://www.netflix.com/in/',
        UK: 'https://www.netflix.com/gb/',
        DE: 'https://www.netflix.com/de/',
        FR: 'https://www.netflix.com/fr/',
        JP: 'https://www.netflix.com/jp/',
        AU: 'https://www.netflix.com/au/',
        CA: 'https://www.netflix.com/ca/',
        BR: 'https://www.netflix.com/br/',
        MX: 'https://www.netflix.com/mx/',
    },
    amazon: {
        US: 'https://www.amazon.com',
        IN: 'https://www.amazon.in',
        UK: 'https://www.amazon.co.uk',
        DE: 'https://www.amazon.de',
        FR: 'https://www.amazon.fr',
        JP: 'https://www.amazon.co.jp',
        AU: 'https://www.amazon.com.au',
        CA: 'https://www.amazon.ca',
        BR: 'https://www.amazon.com.br',
        MX: 'https://www.amazon.com.mx',
    },
    prime: {
        US: 'https://www.primevideo.com',
        IN: 'https://www.primevideo.com/region/in/',
        UK: 'https://www.primevideo.com/region/eu/',
        DE: 'https://www.primevideo.com/region/de/',
        FR: 'https://www.primevideo.com/region/fr/',
        JP: 'https://www.primevideo.com/region/jp/',
        AU: 'https://www.primevideo.com/region/au/',
        CA: 'https://www.primevideo.com/region/na/',
        BR: 'https://www.primevideo.com/region/br/',
        MX: 'https://www.primevideo.com/region/na/',
    },
    primevideo: {
        US: 'https://www.primevideo.com',
        IN: 'https://www.primevideo.com/region/in/',
        UK: 'https://www.primevideo.com/region/eu/',
        DE: 'https://www.primevideo.com/region/de/',
        FR: 'https://www.primevideo.com/region/fr/',
        JP: 'https://www.primevideo.com/region/jp/',
        AU: 'https://www.primevideo.com/region/au/',
        CA: 'https://www.primevideo.com/region/na/',
        BR: 'https://www.primevideo.com/region/br/',
        MX: 'https://www.primevideo.com/region/na/',
    },
};

/** Hostname to site key (for resolving from existing URL) */
const HOST_TO_SITE: Record<string, string> = {
    'netflix.com': 'netflix',
    'www.netflix.com': 'netflix',
    'amazon.com': 'amazon',
    'www.amazon.com': 'amazon',
    'amazon.in': 'amazon',
    'www.amazon.in': 'amazon',
    'amazon.co.uk': 'amazon',
    'www.amazon.co.uk': 'amazon',
    'primevideo.com': 'prime',
    'www.primevideo.com': 'prime',
};

/**
 * Normalize region from locale string (e.g. "en-IN" -> "IN", "en-US" -> "US")
 * or from TLD (e.g. ".in" -> "IN"). Returns undefined if unknown.
 */
export function normalizeRegion(localeOrTld?: string | null): RegionCode | undefined {
    if (!localeOrTld || typeof localeOrTld !== 'string') return undefined;
    const v = localeOrTld.trim().toUpperCase();
    // Locale format: en-IN, hi-IN, en-US
    if (v.includes('-')) {
        const part = v.split('-').pop();
        if (part && part.length === 2) return part as RegionCode;
    }
    // TLD: .in, .uk (we get "IN", "UK" from hostname)
    if (v.length === 2) return v as RegionCode;
    return undefined;
}

/**
 * Get the regional URL for a given absolute URL or site name.
 * If url is e.g. https://www.netflix.com and region is IN, returns https://www.netflix.com/in/
 * If siteName is "amazon" and region is IN, returns https://www.amazon.in
 */
export function getRegionalUrl(
    urlOrSite: string,
    region: RegionCode | undefined
): string {
    if (!region || region === DEFAULT_REGION) return urlOrSite;

    // If it's a URL, resolve by hostname
    try {
        const u = new URL(urlOrSite);
        const host = u.hostname.toLowerCase();
        const siteKey = HOST_TO_SITE[host];
        if (siteKey) {
            const regional = SITE_REGIONAL_URLS[siteKey]?.[region];
            if (regional) return regional;
        }
    } catch {
        // Not a URL; treat as site name below
    }

    // Site name (e.g. "amazon", "netflix", "prime video")
    const siteKey = urlOrSite.toLowerCase().replace(/^https?:\/\//, '').split(/[/?]/)[0]
        .replace(/^www\./, '').trim();
    const regional = SITE_REGIONAL_URLS[siteKey]?.[region];
    if (regional) return regional;

    return urlOrSite;
}

/**
 * Apply region to all open_tab / navigate steps in a plan.
 * Steps with params.url that match a known regional site get their URL replaced.
 */
export function applyRegionToPlanSteps(
    steps: Array<{ action?: string; params?: Record<string, unknown> }>,
    region: RegionCode | undefined
): void {
    if (!region) return;
    for (const step of steps) {
        if ((step.action === 'open_tab' || step.action === 'navigate') && step.params?.url && typeof step.params.url === 'string') {
            const resolved = getRegionalUrl(step.params.url, region);
            if (resolved !== step.params.url) {
                step.params.url = resolved;
            }
        }
    }
}

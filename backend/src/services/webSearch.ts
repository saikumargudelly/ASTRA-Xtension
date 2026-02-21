// ─── Web Search Service ───
// Provides web search capabilities using DuckDuckGo (free, no API key required)
// Falls back to HTML scraping if instant answer API is unavailable

import type { WebSearchResult, WebSearchOptions } from '../types/index.js';

// ─── Error Types ───

export class WebSearchError extends Error {
    constructor(
        message: string,
        public code: 'TIMEOUT' | 'NETWORK' | 'PARSE' | 'RATE_LIMIT' | 'UNKNOWN',
        public originalError?: Error
    ) {
        super(message);
        this.name = 'WebSearchError';
    }
}

// ─── Main Search Function ───

/**
 * Search the web using DuckDuckGo Instant Answer API
 * Falls back to HTML scraping if instant answer is unavailable
 */
export async function searchWeb(
    query: string,
    options: WebSearchOptions = {}
): Promise<WebSearchResult[]> {
    const {
        maxResults = 10,
        excludeDomains = [],
        includeDomains = [],
        region = 'us-en',
        safeSearch = true,
        timeRange
    } = options;

    // Build search query with domain filters
    let searchQuery = query;
    
    if (includeDomains.length > 0) {
        searchQuery += ' ' + includeDomains.map(d => `site:${d}`).join(' OR ');
    }
    
    if (excludeDomains.length > 0) {
        searchQuery += ' ' + excludeDomains.map(d => `-site:${d}`).join(' ');
    }

    // Add time range filter
    if (timeRange) {
        const timeMap: Record<string, string> = {
            day: 'd',
            week: 'w',
            month: 'm',
            year: 'y'
        };
        // Note: DuckDuckGo doesn't support time range in API, but we can try
    }

    try {
        // Method 1: DuckDuckGo Instant Answer API (free, no key)
        const instantResults = await searchDuckDuckGoInstant(searchQuery, maxResults);
        
        if (instantResults.length > 0) {
            return rankResults(instantResults, query);
        }

        // Method 2: DuckDuckGo HTML scraping (fallback)
        const scrapedResults = await searchDuckDuckGoHTML(searchQuery, maxResults, region);
        return rankResults(scrapedResults, query);

    } catch (error) {
        console.error('[WebSearch] Search failed:', error);
        throw new WebSearchError(
            `Web search failed: ${(error as Error).message}`,
            'NETWORK',
            error as Error
        );
    }
}

// ─── DuckDuckGo Instant Answer API ───

interface DuckDuckGoTopic {
    FirstURL?: string;
    Text?: string;
}

interface DuckDuckGoResponse {
    RelatedTopics?: DuckDuckGoTopic[];
    Abstract?: string;
    AbstractURL?: string;
    Heading?: string;
}

async function searchDuckDuckGoInstant(
    query: string,
    maxResults: number
): Promise<WebSearchResult[]> {
    const url = new URL('https://api.duckduckgo.com/');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('skip_disambig', '1');

    const response = await fetch(url.toString(), {
        headers: {
            'Accept': 'application/json',
        }
    });

    if (!response.ok) {
        throw new WebSearchError(`DuckDuckGo API error: ${response.status}`, 'NETWORK');
    }

    const data = await response.json() as DuckDuckGoResponse;
    const results: WebSearchResult[] = [];

    // Extract related topics
    if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
        for (const topic of data.RelatedTopics.slice(0, maxResults)) {
            if (topic.FirstURL && topic.Text) {
                results.push({
                    title: extractTitleFromText(topic.Text),
                    url: topic.FirstURL,
                    snippet: topic.Text,
                    source: extractDomain(topic.FirstURL),
                });
            }
        }
    }

    // Extract abstract if available
    if (data.Abstract && data.AbstractURL) {
        results.unshift({
            title: data.Heading || 'Summary',
            url: data.AbstractURL,
            snippet: data.Abstract,
            source: extractDomain(data.AbstractURL),
        });
    }

    return results;
}

// ─── DuckDuckGo HTML Scraping (Fallback) ───

async function searchDuckDuckGoHTML(
    query: string,
    maxResults: number,
    region: string
): Promise<WebSearchResult[]> {
    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', query);
    url.searchParams.set('kl', region);

    const response = await fetch(url.toString(), {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html',
        }
    });

    if (!response.ok) {
        throw new WebSearchError(`DuckDuckGo HTML error: ${response.status}`, 'NETWORK');
    }

    const html = await response.text();
    return parseDDGHTML(html, maxResults);
}

function parseDDGHTML(html: string, maxResults: number): WebSearchResult[] {
    const results: WebSearchResult[] = [];
    
    // Regex patterns for DuckDuckGo HTML
    const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g;
    const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([^<]*)<\/a>/g;

    let match;
    let count = 0;

    while ((match = resultPattern.exec(html)) !== null && count < maxResults) {
        const url = match[1];
        const title = match[2].trim();
        
        // DuckDuckGo uses redirect URLs, extract actual URL
        const actualUrl = extractRedirectUrl(url);
        
        results.push({
            title,
            url: actualUrl,
            snippet: '', // Will be filled by snippet pattern
            source: extractDomain(actualUrl),
        });
        count++;
    }

    return results;
}

// ─── Page Content Fetching ───

export interface FetchPageOptions {
    timeout?: number;
    maxContentLength?: number;
    followRedirects?: boolean;
    userAgent?: string;
}

/**
 * Fetch and extract text content from a web page
 */
export async function fetchPageContent(
    url: string,
    options: FetchPageOptions = {}
): Promise<string> {
    const {
        timeout = 10000,
        maxContentLength = 50000,
        followRedirects = true,
        userAgent = 'Mozilla/5.0 (compatible; ASTRA-Bot/1.0; +https://github.com/astra)'
    } = options;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            redirect: followRedirects ? 'follow' : 'manual',
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new WebSearchError(`HTTP ${response.status}: ${response.statusText}`, 'NETWORK');
        }

        const contentType = response.headers.get('content-type') || '';
        
        if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
            throw new WebSearchError(`Unsupported content type: ${contentType}`, 'PARSE');
        }

        const html = await response.text();
        
        if (html.length > maxContentLength) {
            console.warn(`[WebSearch] Content truncated from ${html.length} to ${maxContentLength}`);
        }

        return extractTextFromHTML(html.slice(0, maxContentLength));

    } catch (error) {
        clearTimeout(timeoutId);
        
        if ((error as Error).name === 'AbortError') {
            throw new WebSearchError(`Request timeout after ${timeout}ms`, 'TIMEOUT');
        }
        
        if (error instanceof WebSearchError) {
            throw error;
        }
        
        throw new WebSearchError(
            `Failed to fetch page: ${(error as Error).message}`,
            'UNKNOWN',
            error as Error
        );
    }
}

/**
 * Extract readable text from HTML content
 */
function extractTextFromHTML(html: string): string {
    // Remove scripts, styles, and other non-content elements
    let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ')  // Remove remaining tags
        .replace(/\s+/g, ' ')       // Normalize whitespace
        .replace(/&nbsp;/g, ' ')
        .replace(/&/g, '&')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        .replace(/"/g, '"')
        .replace(/'/g, "'")
        .trim();

    return text;
}

// ─── Result Ranking ───

/**
 * Rank search results by relevance to the query
 */
function rankResults(
    results: WebSearchResult[],
    query: string
): WebSearchResult[] {
    if (results.length === 0) return results;

    const queryTerms = query.toLowerCase().split(/\s+/);
    
    const scored = results.map(result => {
        let score = 0;
        const titleLower = result.title.toLowerCase();
        const snippetLower = result.snippet.toLowerCase();
        
        for (const term of queryTerms) {
            if (titleLower.includes(term)) score += 3;
            if (snippetLower.includes(term)) score += 1;
        }
        
        // Boost official documentation sites
        if (isOfficialSource(result.source)) {
            score += 2;
        }
        
        return { ...result, relevanceScore: score };
    });

    return scored.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
}

// ─── Helper Functions ───

function extractDomain(url: string): string {
    try {
        const parsed = new URL(url);
        return parsed.hostname.replace('www.', '');
    } catch {
        return 'unknown';
    }
}

function extractTitleFromText(text: string): string {
    // DuckDuckGo returns "Title - Description" format
    const parts = text.split(' - ');
    return parts[0] || text.slice(0, 100);
}

function extractRedirectUrl(redirectUrl: string): string {
    // DuckDuckGo uses URLs like: //duckduckgo.com/l/?uddg=ENCODED_URL
    try {
        const url = new URL(redirectUrl, 'https://duckduckgo.com');
        const uddg = url.searchParams.get('uddg');
        return uddg ? decodeURIComponent(uddg) : redirectUrl;
    } catch {
        return redirectUrl;
    }
}

function isOfficialSource(domain: string): boolean {
    const officialPatterns = [
        /\.oracle\.com$/i,
        /\.facebook\.com$/i,
        /\.meta\.com$/i,
        /\.google\.com$/i,
        /\.microsoft\.com$/i,
        /\.apple\.com$/i,
        /support\./i,
        /docs\./i,
        /help\./i,
        /documentation\./i,
    ];

    return officialPatterns.some(pattern => pattern.test(domain));
}

// ─── Retry Logic ───

export async function withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 2,
    delayMs: number = 1000
): Promise<T> {
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error as Error;
            
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)));
            }
        }
    }
    
    throw lastError;
}

// ─── Convenience Functions ───

/**
 * Search for configuration guides for a specific application
 */
export async function searchConfigGuides(
    query: string,
    application: string,
    options: WebSearchOptions = {}
): Promise<WebSearchResult[]> {
    const trustedDomains = getTrustedDomains(application);
    
    const searchQuery = `${application} ${query} configuration guide tutorial how to`;
    
    return searchWeb(searchQuery, {
        ...options,
        includeDomains: trustedDomains.length > 0 ? trustedDomains : undefined,
        timeRange: 'year', // Prefer recent guides
    });
}

function getTrustedDomains(application: string): string[] {
    const domainMap: Record<string, string[]> = {
        'facebook': ['facebook.com', 'meta.com', 'help.instagram.com'],
        'meta': ['meta.com', 'facebook.com'],
        'instagram': ['help.instagram.com', 'meta.com'],
        'oracle': ['oracle.com', 'docs.oracle.com'],
        'oci': ['docs.oracle.com', 'oracle.com'],
        'oic': ['docs.oracle.com', 'oracle.com'],
        'ofsc': ['docs.oracle.com', 'oracle.com'],
        'oracle field service': ['docs.oracle.com', 'oracle.com'],
        'oracle integration cloud': ['docs.oracle.com', 'oracle.com'],
        'google': ['support.google.com', 'google.com'],
        'microsoft': ['microsoft.com', 'support.microsoft.com', 'learn.microsoft.com'],
        'azure': ['learn.microsoft.com', 'azure.microsoft.com'],
        'aws': ['docs.aws.amazon.com', 'aws.amazon.com'],
        'amazon': ['docs.aws.amazon.com', 'amazon.com'],
        'apple': ['apple.com', 'support.apple.com'],
        'github': ['docs.github.com', 'github.com'],
        'vscode': ['code.visualstudio.com', 'docs.microsoft.com'],
        'visual studio code': ['code.visualstudio.com'],
    };
    
    const appLower = application.toLowerCase();
    return domainMap[appLower] || [];
}

// ─── Export All ───

export default {
    searchWeb,
    searchConfigGuides,
    fetchPageContent,
    withRetry,
    WebSearchError,
};

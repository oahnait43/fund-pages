const SUPPORTED_FUNDS = new Set([
    '021532', '011035', '017192', '008705', '002910', '012447', '110023',
    '005609', '000251', '009265', '001856', '007099', '012920', '025209'
]);

const HOLDINGS_CACHE_SECONDS = 6 * 60 * 60;
const RESPONSE_CACHE_SECONDS = 20;

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': status === 200
                ? `public, max-age=${RESPONSE_CACHE_SECONDS}`
                : 'no-store'
        }
    });
}

function latestCompletedQuarter(now = new Date()) {
    const shanghai = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const year = shanghai.getFullYear();
    const month = shanghai.getMonth() + 1;
    if (month <= 3) return { year: year - 1, month: 12 };
    if (month <= 6) return { year, month: 3 };
    if (month <= 9) return { year, month: 6 };
    return { year, month: 9 };
}

function stripTags(value) {
    return value
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .trim();
}

async function fetchWithRetry(url, init, attempts = 3) {
    let lastResponse;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        lastResponse = await fetch(url, init);
        if (lastResponse.ok || (lastResponse.status < 500 && lastResponse.status !== 429)) {
            return lastResponse;
        }
        await new Promise(resolve => setTimeout(resolve, 300 * (2 ** attempt)));
    }
    return lastResponse;
}

async function mapInBatches(items, batchSize, mapper) {
    const settled = [];
    for (let index = 0; index < items.length; index += batchSize) {
        settled.push(...await Promise.allSettled(items.slice(index, index + batchSize).map(mapper)));
    }
    return settled;
}

function parseHoldings(source, year, quarterMonth) {
    const disclosedPeriod = source.match(/(\d{4})年([1-4])季度/);
    const disclosedYear = disclosedPeriod ? Number(disclosedPeriod[1]) : year;
    const disclosedMonth = disclosedPeriod ? Number(disclosedPeriod[2]) * 3 : quarterMonth;
    const table = source.match(/<table[\s\S]*?<\/table>/i)?.[0];
    if (!table) {
        return {
            date: `${disclosedYear}-${String(disclosedMonth).padStart(2, '0')}-${disclosedMonth === 3 || disclosedMonth === 12 ? 31 : 30}`,
            holdings: []
        };
    }

    const holdings = [];
    for (const row of table.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
        const secid = row.match(/unify\/r\/([\w.]+)/i)?.[1];
        const weight = Number(row.match(/<td[^>]*class=['"]tor['"][^>]*>\s*([\d.]+)%/i)?.[1]);
        if (!secid || !Number.isFinite(weight) || weight <= 0) continue;

        const linkedValues = [...row.matchAll(/unify\/r\/[\w.]+[^>]*>([^<]+)<\/a>/gi)]
            .map(match => stripTags(match[1]));
        holdings.push({
            secid,
            code: linkedValues[0] || secid.split('.').pop(),
            name: linkedValues[1] || linkedValues[0] || secid,
            weight
        });
    }

    const quarterEndDay = disclosedMonth === 3 || disclosedMonth === 12 ? 31 : 30;
    return {
        date: `${disclosedYear}-${String(disclosedMonth).padStart(2, '0')}-${quarterEndDay}`,
        holdings
    };
}

async function fetchHoldings(code, context) {
    const { year: currentYear, month: fallbackMonth } = latestCompletedQuarter();
    let latest = { date: null, holdings: [] };
    for (const year of [currentYear, currentYear - 1]) {
        const upstream = new URL('https://fundf10.eastmoney.com/FundArchivesDatas.aspx');
        upstream.searchParams.set('type', 'jjcc');
        upstream.searchParams.set('code', code);
        upstream.searchParams.set('topline', '10');
        upstream.searchParams.set('year', String(year));
        upstream.searchParams.set('month', '');

        const cache = caches.default;
        const cacheKey = new Request(`https://fund-pages-cache.invalid/holdings/${code}/${year}/latest`);
        let response = await cache.match(cacheKey);
        if (!response) {
            const upstreamResponse = await fetchWithRetry(upstream, {
                headers: {
                    'user-agent': 'Mozilla/5.0',
                    referer: `https://fundf10.eastmoney.com/ccmx_${code}.html`
                }
            });
            if (!upstreamResponse.ok) throw new Error(`holdings HTTP ${upstreamResponse.status}`);
            response = new Response(await upstreamResponse.text(), {
                headers: { 'cache-control': `public, max-age=${HOLDINGS_CACHE_SECONDS}` }
            });
            context.waitUntil(cache.put(cacheKey, response.clone()));
        }

        latest = parseHoldings(await response.text(), year, fallbackMonth);
        if (latest.holdings.length > 0) break;
    }

    return { code, ...latest };
}

async function fetchQuoteBatch(secids) {
    const url = new URL('https://push2delay.eastmoney.com/api/qt/ulist.np/get');
    url.searchParams.set('fltt', '2');
    url.searchParams.set('secids', secids.join(','));
    url.searchParams.set('fields', 'f2,f3,f12,f13,f14,f124');

    const response = await fetchWithRetry(url, {
        headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://quote.eastmoney.com/' }
    });
    if (!response.ok) throw new Error(`quotes HTTP ${response.status}`);
    const payload = await response.json();
    const quotes = new Map();
    for (const item of payload?.data?.diff || []) {
        const secid = `${item.f13}.${item.f12}`;
        const change = Number(item.f3);
        if (!Number.isFinite(change)) continue;
        quotes.set(secid, {
            change,
            price: Number.isFinite(Number(item.f2)) ? Number(item.f2) : null,
            timestamp: Number.isFinite(Number(item.f124)) ? Number(item.f124) : null
        });
    }
    return quotes;
}

async function fetchQuotes(secids) {
    const quotes = new Map();
    for (let index = 0; index < secids.length; index += 40) {
        const batch = await fetchQuoteBatch(secids.slice(index, index + 40));
        for (const [secid, quote] of batch) quotes.set(secid, quote);
    }
    return quotes;
}

export async function onRequestGet({ request, waitUntil }) {
    const requestedCodes = (new URL(request.url).searchParams.get('codes') || '')
        .split(',')
        .map(code => code.trim())
        .filter(code => /^\d{6}$/.test(code) && SUPPORTED_FUNDS.has(code));
    const codes = [...new Set(requestedCodes)];
    if (codes.length === 0) return json({ error: 'No supported fund codes' }, 400);

    try {
        const context = { waitUntil };
        const settledFunds = await mapInBatches(codes, 2, code => fetchHoldings(code, context));
        const funds = settledFunds
            .filter(result => result.status === 'fulfilled')
            .map(result => result.value);
        const errors = settledFunds
            .map((result, index) => result.status === 'rejected'
                ? { code: codes[index], error: result.reason instanceof Error ? result.reason.message : 'holdings failed' }
                : null)
            .filter(Boolean);
        if (funds.length === 0) {
            throw new Error(errors[0]?.error || 'No holdings available');
        }
        const secids = [...new Set(funds.flatMap(fund => fund.holdings.map(item => item.secid)))];
        const quotes = await fetchQuotes(secids);

        return json({
            errors,
            funds: funds.map(fund => ({
                code: fund.code,
                holdingsDate: fund.date,
                holdings: fund.holdings.map(holding => ({
                    ...holding,
                    quote: quotes.get(holding.secid) || null
                }))
            }))
        });
    } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'Estimate source failed' }, 502);
    }
}
